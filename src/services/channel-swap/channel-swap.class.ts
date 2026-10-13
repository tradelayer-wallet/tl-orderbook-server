import { randomBytes } from "crypto";
import { Server, Socket } from "socket.io";
import { envConfig } from "../../config/env.config";
import { IResult, IResultChannelSwap } from "../../utils/types/mix.types";
import { ITradeInfo, TOrder } from "../../utils/types/orderbook.types";
import { EmitEvents, OrderEmitEvents } from "../socket/events";
import { swapRelayLimiter } from "../socket/limiters";

// Swap wire protocol (server <-> wallet client):
//   'new-channel'  server -> each participant : { tradeInfo, unfilled, isBuyer, sessionId }
//   'swap'         participant -> server      : { sessionId, eventName, socketId, data }
//   'swap'         server -> counterparty     : the same payload, relayed unchanged
// A swap is identified only by its server-generated sessionId. Socket ids and any
// client-supplied field never select a session; `socketId` in a payload is advisory.

export interface ISwapEvent {
    sessionId: string;
    eventName: string;
    socketId?: string;
    data?: any;
}

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

// Single entry point for every inbound swap event. The sessionId selects the
// session, and the emitting socket must be one of that session's two participants.
// Unknown and foreign sessions get the same error, so responses do not reveal which
// session ids exist. Rate limiting is per emitting socket, before any lookup.
export const routeSwapEvent = (from: Socket, payload: unknown): void => {
    if (!swapRelayLimiter.consume(from.id)) {
        from.emit(OrderEmitEvents.ERROR, 'Rate limit exceeded');
        return;
    }
    const sessionId = isObject(payload) && typeof payload.sessionId === 'string' ? payload.sessionId : null;
    const session = sessionId !== null ? sessions.get(sessionId) : undefined;
    if (!session || !session.hasParticipant(from)) {
        from.emit(OrderEmitEvents.ERROR, 'Invalid swap event: unknown or foreign sessionId');
        return;
    }
    session.handle(from, payload as ISwapEvent);
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
    handle(from: Socket, swapEvent: ISwapEvent): void {
        // Relay only to this session's counterparty.
        const counterparty = from === this.buyer ? this.seller : this.buyer;
        counterparty.emit(EmitEvents.SWAP, swapEvent);

        const { eventName, data } = swapEvent;
        if (eventName === 'BUYER:STEP6' && from === this.buyer) {
            // Only the buyer completes the swap; the seller cannot fake a fill.
            this.settle({ data: { txid: data } });
        }
        if (eventName === 'TERMINATE_TRADE') {
            // The terminator is the participant that emitted the event. The
            // client-supplied socketId is ignored for this decision.
            this.settle({ error: data, socketId: from.id });
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
