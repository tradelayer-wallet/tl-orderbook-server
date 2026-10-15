import { randomBytes } from "crypto";
import { Server, Socket } from "socket.io";
import { envConfig } from "../../config/env.config";
import { ITradeInfo } from "../../utils/types/orderbook.types";
import { EmitEvents, OrderEmitEvents } from "../socket/events";
import { swapRelayLimiter } from "../socket/limiters";
import {
    parseSwapEnvelope,
    parseTerminateReason,
    SERVER_STATE_EVENT,
    SIGNED_STEP_INDEX,
    ISwapEnvelope,
    SWAP_STEPS,
    TERMINATE_EVENT,
} from "../../protocol/messages";

// Swap wire protocol, server <-> wallet (protocol-v2.md B.3.5 and B.4):
//   'new-channel'  server -> each participant : { sessionId, isBuyer, tradeInfo }
//   'swap'         participant -> server      : { sessionId, eventName, data }
//   'swap'         server -> counterparty     : { sessionId, eventName, socketId, data }
//   'swap'         server -> both participants: { sessionId, eventName: 'SERVER:STATE', socketId: null, data }
// A swap is identified only by its server-generated sessionId. Socket ids and any client-supplied
// field never select a session. The relayed `socketId` is stamped by the server from the emitting
// socket, so a client cannot claim another identity.

export type TSwapOutcome =
    | { state: 'settled'; txid: string }
    // `terminatorSocketId` is set when a participant sent TERMINATE_TRADE. A timeout has none.
    | { state: 'aborted'; reason: string; terminatorSocketId?: string }
    // The buyer held a signed transaction and the window to report it closed. Nothing is recorded.
    | { state: 'expired-unverified' };

// The reason a trade was terminated is relayed into the counterparty's order:error,
// so it is bounded by the schema (256 characters).
const TERMINATE_FALLBACK = 'Trade terminated by counterparty';

export interface ISwapParticipants {
    buyer: Socket;
    seller: Socket;
}

// The single choke point where a swap resolves its two sockets. A session is only
// ever built around two distinct sockets that are connected right now.
export const resolveSwapParticipants = (io: Server, tradeInfo: ITradeInfo): { data?: ISwapParticipants; error?: string } => {
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

// Single entry point for every inbound swap event. The payload is checked by one schema
// (parseSwapEnvelope). The sessionId selects the session, and the emitting socket must be one of
// that session's two participants. Unknown and foreign sessions get the same error, so responses do
// not reveal which session ids exist. Rate limiting is per emitting socket, before any lookup.
export const routeSwapEvent = (from: Socket, payload: unknown): void => {
    if (!swapRelayLimiter.consume(from.id)) {
        from.emit(OrderEmitEvents.ERROR, 'Rate limit exceeded');
        return;
    }
    const envelope = parseSwapEnvelope(payload);
    if (envelope.error || !envelope.data) {
        from.emit(OrderEmitEvents.ERROR, envelope.error);
        return;
    }
    const session = sessions.get(envelope.data.sessionId);
    if (!session || !session.hasParticipant(from)) {
        from.emit(OrderEmitEvents.ERROR, 'Invalid swap event: unknown or foreign sessionId');
        return;
    }
    session.handle(from, envelope.data);
};

export class ChannelSwap {
    // 256 bits from a CSPRNG: not guessable by a counterparty or an outsider.
    readonly sessionId: string = randomBytes(32).toString('hex');
    readonly outcome: Promise<TSwapOutcome>;
    private resolveOutcome: (outcome: TSwapOutcome) => void = () => {};
    // Index into SWAP_STEPS of the next event the server accepts. Past the last step the swap is settled.
    private nextStep = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private ended = false;

    constructor(
        private readonly buyer: Socket,
        private readonly seller: Socket,
        tradeInfo: ITradeInfo,
    ) {
        this.outcome = new Promise<TSwapOutcome>((res) => {
            this.resolveOutcome = res;
        });
        sessions.set(this.sessionId, this);
        // Negotiation must finish within SWAP_TIMEOUT_MS. Before SELLER:STEP5 no signed
        // transaction exists, so an expiry here is a plain abort and the maker is unlocked.
        this.arm(envConfig.SWAP_TIMEOUT_MS, () => this.end({
            state: 'aborted',
            reason: `Swap timed out after ${envConfig.SWAP_TIMEOUT_MS}ms`,
        }));
        const trade = { sessionId: this.sessionId, tradeInfo };
        this.buyer.emit(EmitEvents.NEW_CHANNEL, { ...trade, isBuyer: true });
        this.seller.emit(EmitEvents.NEW_CHANNEL, { ...trade, isBuyer: false });
    }

    hasParticipant(socket: Socket): boolean {
        return socket === this.buyer || socket === this.seller;
    }

    // Only called by routeSwapEvent, after `from` was verified as a participant.
    handle(from: Socket, envelope: ISwapEnvelope): void {
        if (envelope.eventName === TERMINATE_EVENT) {
            this.terminate(from, envelope.data);
            return;
        }
        const sender = from === this.buyer ? 'BUYER' : 'SELLER';
        const step = SWAP_STEPS[this.nextStep];
        if (!step || step.eventName !== envelope.eventName || step.sender !== sender) {
            from.emit(OrderEmitEvents.ERROR, `Invalid swap event: ${envelope.eventName} is not the next step`);
            return;
        }
        const parsed = step.parse(envelope.data);
        if (parsed.error) {
            from.emit(OrderEmitEvents.ERROR, `Invalid swap event: ${envelope.eventName} data does not match its schema`);
            return;
        }
        this.nextStep++;
        const counterparty = from === this.buyer ? this.seller : this.buyer;
        counterparty.emit(EmitEvents.SWAP, { sessionId: this.sessionId, eventName: envelope.eventName, socketId: from.id, data: parsed.data });

        if (this.nextStep - 1 === SIGNED_STEP_INDEX) {
            this.arm(envConfig.SWAP_SIGNED_WINDOW_MS, () => this.end({ state: 'expired-unverified' }));
        }
        if (this.nextStep === SWAP_STEPS.length) {
            this.end({ state: 'settled', txid: parsed.data as string });
        }
    }

    // TERMINATE_TRADE is honoured only before SELLER:STEP5. After it the buyer holds a
    // transaction it can broadcast, so the session can end only as settled or expired-unverified.
    private terminate(from: Socket, data: unknown): void {
        if (this.nextStep > SIGNED_STEP_INDEX) {
            from.emit(OrderEmitEvents.ERROR, 'Invalid swap event: TERMINATE_TRADE is refused after SELLER:STEP5');
            return;
        }
        const parsed = parseTerminateReason(data);
        if (parsed.error) {
            from.emit(OrderEmitEvents.ERROR, 'Invalid swap event: TERMINATE_TRADE data does not match its schema');
            return;
        }
        const reason = parsed.data ?? TERMINATE_FALLBACK;
        const counterparty = from === this.buyer ? this.seller : this.buyer;
        counterparty.emit(EmitEvents.SWAP, { sessionId: this.sessionId, eventName: TERMINATE_EVENT, socketId: from.id, data: reason });
        this.end({ state: 'aborted', reason, terminatorSocketId: from.id });
    }

    private arm(ms: number, onFire: () => void): void {
        this.disarm();
        this.timer = setTimeout(() => {
            this.timer = null;
            onFire();
        }, ms);
    }

    private disarm(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    // The one exit from a session: it leaves the registry, both participants are told the terminal
    // state, and the outcome is resolved once.
    private end(outcome: TSwapOutcome): void {
        if (this.ended) return;
        this.ended = true;
        this.disarm();
        sessions.delete(this.sessionId);
        const state = { state: outcome.state, txid: outcome.state === 'settled' ? outcome.txid : null };
        const notice = { sessionId: this.sessionId, eventName: SERVER_STATE_EVENT, socketId: null, data: state };
        this.buyer.emit(EmitEvents.SWAP, notice);
        this.seller.emit(EmitEvents.SWAP, notice);
        this.resolveOutcome(outcome);
    }
}
