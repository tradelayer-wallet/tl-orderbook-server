import { randomBytes } from "crypto";
import { Server, Socket } from "socket.io";
import { envConfig } from "../../config/env.config";
import { IResult, IResultChannelSwap } from "../../utils/types/mix.types";
import { ITradeInfo, TOrder } from "../../utils/types/orderbook.types";
import { EmitEvents, OrderEmitEvents } from "../socket/events";
import { swapRelayLimiter } from "../socket/limiters";

// Swap wire protocol (server <-> wallet client):
//   'new-channel'  server -> each participant : { tradeInfo, unfilled, isBuyer, sessionId }
//   'swap'         participant -> server      : { sessionId, eventName, data }
//   'swap'         server -> counterparty     : { sessionId, eventName, socketId, data }
// A swap is identified only by its server-generated sessionId. Socket ids and any
// client-supplied field never select a session. The relayed `socketId` is stamped
// by the server from the emitting socket, so a client cannot claim another identity.

export interface ISwapInbound {
    sessionId: string;
    eventName: string;
    data?: unknown;
}

export interface ISwapEvent extends ISwapInbound {
    // The emitting socket, stamped by the server. Never taken from the client.
    socketId: string;
}

const MAX_EVENT_NAME_LENGTH = 64;
// The reason a trade was terminated is relayed into the counterparty's order:error,
// so it is bounded.
const MAX_TERMINATE_REASON_LENGTH = 256;
const TERMINATE_REASON_FALLBACK = 'Trade terminated by counterparty';
// Bitcoin-family transaction id: 32 bytes as 64 hex characters. Anything else is
// refused before it can be recorded as a fill or written to the public history.
// Accepted in either case, stored and relayed in lowercase, so one transaction has
// exactly one textual form in the trade history.
const TXID_PATTERN = /^[0-9a-f]{64}$/i;
// Server-issued sessionIds are randomBytes(32) as hex: exactly 64 lowercase hex chars.
const SESSION_ID_LENGTH = 64;
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface ISwapParticipants {
    buyer: Socket;
    seller: Socket;
}

// The single choke point where a swap resolves its two sockets. A session is only
// ever built around two distinct sockets that are connected right now. A missing or
// disconnected counterparty produces a clean error here, before anything is emitted
// or registered.
export const resolveSwapParticipants = (io: Server, tradeInfo: ITradeInfo): IResult<ISwapParticipants> => {
    const buyer = io.sockets.sockets.get(tradeInfo.buyer.socketId);
    const seller = io.sockets.sockets.get(tradeInfo.seller.socketId);
    if (!buyer || !buyer.connected || !seller || !seller.connected) {
        return { error: 'Counterparty is not connected' };
    }
    if (buyer === seller) {
        return { error: 'Swap participants must be two distinct sockets' };
    }
    return { data: { buyer, seller } };
};

// Every live swap session, keyed by its sessionId. This registry is the only way
// an inbound swap event reaches a session.
const sessions = new Map<string, ChannelSwap>();

export const activeSwapSessionCount = (): number => sessions.size;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const terminationReason = (data: unknown): string =>
    typeof data === 'string' && data.length > 0
        ? data.slice(0, MAX_TERMINATE_REASON_LENGTH)
        : TERMINATE_REASON_FALLBACK;

// Only the fields the protocol uses survive. Anything else the client sent is dropped.
const parseSwapInbound = (payload: unknown): ISwapInbound | null => {
    if (!isObject(payload)) return null;
    const { sessionId, eventName, data } = payload;
    // Length first, so an oversized id is refused before any regex work.
    if (typeof sessionId !== 'string' || sessionId.length !== SESSION_ID_LENGTH || !SESSION_ID_PATTERN.test(sessionId)) return null;
    if (typeof eventName !== 'string' || eventName.length > MAX_EVENT_NAME_LENGTH) return null;
    return { sessionId, eventName, data };
};

// Single entry point for every inbound swap event. The sessionId selects the
// session, and the emitting socket must be one of that session's two participants.
// Unknown and foreign sessions get the same error, so responses do not reveal which
// session ids exist. Rate limiting is per emitting socket, before any lookup.
export const routeSwapEvent = (from: Socket, payload: unknown): void => {
    if (!swapRelayLimiter.consume(from.id)) {
        from.emit(OrderEmitEvents.ERROR, 'Rate limit exceeded');
        return;
    }
    const inbound = parseSwapInbound(payload);
    if (!inbound) {
        from.emit(OrderEmitEvents.ERROR, 'Invalid swap event: sessionId (64 hex characters) and eventName (string) are required');
        return;
    }
    const session = sessions.get(inbound.sessionId);
    if (!session || !session.hasParticipant(from)) {
        from.emit(OrderEmitEvents.ERROR, 'Invalid swap event: unknown or foreign sessionId');
        return;
    }
    session.handle(from, inbound);
};

export class ChannelSwap {
    // 256 bits from a CSPRNG: not guessable by a counterparty or an outsider.
    readonly sessionId: string = randomBytes(32).toString('hex');
    readonly ready: Promise<IResultChannelSwap>;
    private resolveReady: (value: IResultChannelSwap) => void;
    private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    private settled = false;

    constructor(
        private readonly buyer: Socket,
        private readonly seller: Socket,
        private readonly tradeInfo: ITradeInfo,
        private readonly unfilled: TOrder,
    ) {
        this.ready = new Promise<IResultChannelSwap>((res) => {
            this.resolveReady = res;
        });
        sessions.set(this.sessionId, this);
        this.startTimeout();
        const trade = { tradeInfo, unfilled, sessionId: this.sessionId };
        this.buyer.emit(EmitEvents.NEW_CHANNEL, { ...trade, isBuyer: true });
        this.seller.emit(EmitEvents.NEW_CHANNEL, { ...trade, isBuyer: false });
    }

    hasParticipant(socket: Socket): boolean {
        return socket === this.buyer || socket === this.seller;
    }

    // Only called by routeSwapEvent, after `from` was verified as a participant.
    handle(from: Socket, inbound: ISwapInbound): void {
        const { eventName } = inbound;
        const isBuyerFill = eventName === 'BUYER:STEP6' && from === this.buyer;
        // Only the buyer completes the swap; the seller cannot fake a fill. The txid
        // is refused unless well-formed, and the session stays open so the buyer can resend.
        if (isBuyerFill && !(typeof inbound.data === 'string' && TXID_PATTERN.test(inbound.data))) {
            from.emit(OrderEmitEvents.ERROR, 'Invalid BUYER:STEP6: txid must be 64 hex characters');
            return;
        }
        // The one canonical form of the txid: lowercase. Relayed and recorded alike.
        const data = isBuyerFill ? (inbound.data as string).toLowerCase() : inbound.data;

        // Relay only to this session's counterparty, with the sender stamped by the server.
        const counterparty = from === this.buyer ? this.seller : this.buyer;
        const relayed: ISwapEvent = { sessionId: this.sessionId, eventName, socketId: from.id, data };
        counterparty.emit(EmitEvents.SWAP, relayed);

        if (isBuyerFill) {
            this.settle({ data: { txid: data } });
        }
        if (eventName === 'TERMINATE_TRADE') {
            // The terminator is the participant that emitted the event, derived from
            // the socket and never from the payload.
            this.settle({ error: terminationReason(data), socketId: from.id });
        }
    }

    // The swap must complete within SWAP_TIMEOUT_MS, otherwise a silent
    // counterparty could keep the matched (locked) orders locked forever.
    private startTimeout(): void {
        const timeoutMs = envConfig.SWAP_TIMEOUT_MS;
        this.timeoutHandle = setTimeout(() => {
            this.settle({ error: `Swap timed out after ${timeoutMs}ms`, timedOut: true });
        }, timeoutMs);
    }

    private settle(result: IResultChannelSwap): void {
        if (this.settled) return;
        this.settled = true;
        if (this.timeoutHandle) {
            clearTimeout(this.timeoutHandle);
            this.timeoutHandle = null;
        }
        // A settled session's id stops routing, so late or replayed events are rejected.
        sessions.delete(this.sessionId);
        this.resolveReady(result);
    }
}
