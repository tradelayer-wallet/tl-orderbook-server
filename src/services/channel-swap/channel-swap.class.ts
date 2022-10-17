import { Socket } from "socket.io";
import { IResultChannelSwap } from "../../utils/types/mix.types";
import { ITradeInfo, TOrder } from "../../utils/types/orderbook.types";


class SwapEvent {
    constructor(
        public eventName: string,
        public socketId: string,
        public data: any,
    ) {}
}
const swapEventName = 'swap';
export class ChannelSwap {
    private readyRes: (value: IResultChannelSwap) => void;
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
        });
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
                        c.on(`${p}::${swapEventName}`, (swapEvent: SwapEvent) => {
                            const { eventName, data, socketId } = swapEvent;
                            if (eventName === "BUYER:STEP6") {
                                if (this.readyRes) this.readyRes({ data: { txid: data } });
                                this.removePreviuesEventListeners(swapEventName);
                            }
        
                            if (eventName === "TERMINATE_TRADE") {
                                if (this.readyRes) this.readyRes({ error: data, socketId });
                                this.removePreviuesEventListeners(swapEventName);
                            }
                        });
                    });
            });
    }

    private removePreviuesEventListeners(event: string) {
        this.client.removeAllListeners(`${this.client.id}::${event}`);
        this.dealer.removeAllListeners(`${this.dealer.id}::${event}`);
    }

    private handleEventsAndPassToCP(event: string) {
        const dealerEvent = `${this.dealer.id}::${event}`;
        const clientEvent = `${this.client.id}::${event}`;
        this.dealer.on(dealerEvent, (data: SwapEvent) => this.client.emit(dealerEvent, data));
        this.client.on(clientEvent, (data: SwapEvent) => this.dealer.emit(clientEvent, data));
    }
}