import { Socket } from "socket.io";
import { envConfig } from "../../config/env.config";
import { IResultChannelSwap } from "../../utils/types/mix.types";
import { ITradeInfo, TOrder } from "../../utils/types/orderbook.types";


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
        this.removePreviuesEventListeners(swapEventName);
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
        this.removePreviuesEventListeners(swapEventName);
        this.handleEventsAndPassToCP(swapEventName);
        [this.client.id, this.dealer.id]
            .forEach(p => {
                [this.dealer, this.client]
                    .forEach(c => {
                        this.addListener(c, `${p}::${swapEventName}`, (swapEvent: SwapEvent) => {
                            const { eventName, data, socketId } = swapEvent;
                            if (eventName === "BUYER:STEP6") {
                                this.settle({ data: { txid: data } });
                            }
        
                            if (eventName === "TERMINATE_TRADE") {
                                this.settle({ error: data, socketId });
                            }
                        });
                    });
            });
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

    private removePreviuesEventListeners(event: string) {
        this.client.removeAllListeners(`${this.client.id}::${event}`);
        this.dealer.removeAllListeners(`${this.dealer.id}::${event}`);
    }

    private handleEventsAndPassToCP(event: string) {
        const dealerEvent = `${this.dealer.id}::${event}`;
        const clientEvent = `${this.client.id}::${event}`;
        this.addListener(this.dealer, dealerEvent, (data: SwapEvent) => this.client.emit(dealerEvent, data));
        this.addListener(this.client, clientEvent, (data: SwapEvent) => this.dealer.emit(clientEvent, data));
    }
}
