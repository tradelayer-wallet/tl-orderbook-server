import uWS from 'uws';
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
    private client: uWS.WebSocket; // uWS WebSocket type
    private dealer: uWS.WebSocket; // uWS WebSocket type

    constructor(
        private clientSocket: uWS.WebSocket, 
        private dealerSocket: uWS.WebSocket, 
        private tradeInfo: ITradeInfo, 
        private unfilled: TOrder,
    ) {
        this.client = clientSocket;
        this.dealer = dealerSocket;
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

        // Send the trade data to both the buyer and dealer
        this.client.send(JSON.stringify({ ...trade, isBuyer: this.client.id === buyerSocketId }));
        this.dealer.send(JSON.stringify({ ...trade, isBuyer: this.dealer.id === buyerSocketId }));
    }

    private handleEvents(): void {
        this.removePreviousEventListeners(swapEventName);
        this.handleEventsAndPassToCP(swapEventName);

        // Handle events for both client and dealer sockets
        [this.client.id, this.dealer.id]
            .forEach(p => {
                [this.dealer, this.client]
                    .forEach(c => {
                        c.on(`${p}::${swapEventName}`, (swapEvent: SwapEvent) => {
                            const { eventName, data, socketId } = swapEvent;
                            if (eventName === "BUYER:STEP6") {
                                if (this.readyRes) this.readyRes({ data: { txid: data } });
                                this.removePreviousEventListeners(swapEventName);
                            }

                            if (eventName === "TERMINATE_TRADE") {
                                if (this.readyRes) this.readyRes({ error: data, socketId });
                                this.removePreviousEventListeners(swapEventName);
                            }
                        });
                    });
            });
    }

    private removePreviousEventListeners(event: string) {
        // In uWS, we don't have the same listener management as socket.io, but you can manage it on your own
        // You may need to manually track which events are added and remove them explicitly
        this.client.removeAllListeners(`${this.client.id}::${event}`);
        this.dealer.removeAllListeners(`${this.dealer.id}::${event}`);
    }

    private handleEventsAndPassToCP(event: string) {
        const dealerEvent = `${this.dealer.id}::${event}`;
        const clientEvent = `${this.client.id}::${event}`;

        // Forward events between client and dealer sockets
        this.dealer.on(dealerEvent, (data: SwapEvent) => this.client.send(dealerEvent, data));
        this.client.on(clientEvent, (data: SwapEvent) => this.dealer.send(clientEvent, data));
    }
}
