import { Socket } from "socket.io";
import { envConfig } from "../../config/env.config";
import { IResultChannelSwap } from "../../utils/types/mix.types";
import { TokenBucketLimiter } from "../../utils/pure/rate-limit.pure";
import { ITradeInfo, TOrder } from "../../utils/types/orderbook.types";
import { OrderEmitEvents } from "../socket/events";


class SwapEvent {
    constructor(
        public eventName: string,
        public socketId: string,
        public data: any,
    ) {}
}

interface ISwapListener {
    socket: Socket;
    event: string;
    handler: (swapEvent: SwapEvent) => void;
}

const swapEventName = 'swap';

// Swap-channel relay traffic is rate limited per emitting socket so a client
// cannot use the relay as a bandwidth amplifier against its counterparty.
const swapEventLimiter = new TokenBucketLimiter(10, 50);

export class ChannelSwap {
    private readyRes: (value: IResultChannelSwap) => void;
    private timeoutHandle: any = null;
    private settled: boolean = false;
    private sessionListeners: ISwapListener[] = [];
    constructor(
        private client: Socket, 
        private dealer: Socket, 
        private tradeInfo: ITradeInfo, 
        private unfilled: TOrder,
    ) {
        this.onReady();
        this.openChannel();
    }

    onReady() {
        return new Promise<IResultChannelSwap>((res) => {
            this.readyRes = res;
            this.startTimeout();
        });
    }

    // The swap must complete within SWAP_TIMEOUT_MS, otherwise a silent
    // counterparty could keep the matched (locked) orders locked forever.
    private startTimeout(): void {
        if (this.timeoutHandle) return;
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
        // Remove exactly this session's listeners. Other in-flight swap sessions
        // on the same sockets must keep their relays alive — never use
        // removeAllListeners here.
        this.removeSessionListeners();
        if (this.readyRes) this.readyRes(result);
    }

    private openChannel(): void {
        this.handleEvents();
        const buyerSocketId = this.tradeInfo.buyer.socketId;
        const trade = { tradeInfo: this.tradeInfo, unfilled: this.unfilled };
        this.client.emit('new-channel', { ...trade, isBuyer: this.client.id === buyerSocketId });
        this.dealer.emit('new-channel', { ...trade, isBuyer: this.dealer.id === buyerSocketId });
    }

    private handleEvents(): void {
        const sockets: Socket[] = [this.client, this.dealer];
        const channels: string[] = [
            `${this.client.id}::${swapEventName}`,
            `${this.dealer.id}::${swapEventName}`,
        ];
        sockets.forEach(c => channels.forEach(channel => {
            this.addListener(c, channel, (swapEvent: SwapEvent) => {
                if (!swapEventLimiter.consume(c.id)) {
                    c.emit(OrderEmitEvents.ERROR, 'Rate limit exceeded');
                    return;
                }

                // Relay only events sent on the emitting socket's own channel:
                // a socket cannot inject messages into the counterparty's channel.
                if (channel === `${c.id}::${swapEventName}`) {
                    const counterparty = c === this.client ? this.dealer : this.client;
                    counterparty.emit(channel, swapEvent);
                }

                const { eventName, data } = swapEvent || ({} as SwapEvent);
                if (eventName === "BUYER:STEP6") {
                    // Only the buyer completes the swap (the counterparty must not
                    // be able to fake a fill).
                    if (c.id === this.tradeInfo.buyer.socketId) {
                        this.settle({ data: { txid: data } });
                    }
                }

                if (eventName === "TERMINATE_TRADE") {
                    // The terminator is the socket that actually emitted the event.
                    // `swapEvent.socketId` is client-supplied and spoofable, so it
                    // must never decide which of the two orders gets deleted.
                    this.settle({ error: data, socketId: c.id });
                }
            });
        }));
    }

    private addListener(socket: Socket, event: string, handler: (swapEvent: SwapEvent) => void) {
        socket.on(event, handler);
        this.sessionListeners.push({ socket, event, handler });
    }

    // Removes exactly the listeners this swap session registered.
    private removeSessionListeners() {
        this.sessionListeners.forEach(({ socket, event, handler }) => socket.removeListener(event, handler));
        this.sessionListeners = [];
    }
}
