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
    private eventListeners: Map<string, Set<string>> = new Map(); // Map to track listeners per socket

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
        this.client.send(JSON.stringify({ ...trade, isBuyer: String(this.client.getId()) === buyerSocketId }));
        this.dealer.send(JSON.stringify({ ...trade, isBuyer: String(this.dealer.getId()) === buyerSocketId }));
    }

    private handleEvents(): void {
        this.handleEventsAndPassToCP(swapEventName);

        // Listen for events from both client and dealer
        [this.client.getId(), this.dealer.getId()]
            .forEach(p => {
                [this.dealer, this.client]
                    .forEach(c => {
                        // Listen for events with a more elaborate tracking mechanism
                        c.on(`${p}::${swapEventName}`, (swapEvent: SwapEvent) => {
                            const { eventName, data, socketId } = swapEvent;
                            if (eventName === "BUYER:STEP6") {
                                if (this.readyRes) this.readyRes({ data: { txid: data } });
                                this.removeListenerFromSocket(this.client.getId(),this.dealer.getId(),eventName)
                            }

                            if (eventName === "TERMINATE_TRADE") {
                                if (this.readyRes) this.readyRes({ error: data, socketId });
                                this.removeListenerFromSocket(this.client.getId(),this.dealer.getId(),eventName)
                            }
                        });
                        this.addListenerToSocket(c, `${p}::${swapEventName}`);
                    });
            });
    }

    // Add listener tracking
    private addListenerToSocket(socket: uWS.WebSocket, event: string) {
        const socketId = String(socket.getId());
        if (!this.eventListeners.has(socketId)) {
            this.eventListeners.set(socketId, new Set());
        }
        this.eventListeners.get(socketId)?.add(event);
    }

    // Remove listeners when necessary
    private removeListenerFromSocket(clientSocket: uWS.WebSocket, dealerSocket: uWS.WebSocket, event: string) {
        const clientSocketId = String(clientSocket.getId());
        const dealerSocketId = String(dealerSocket.getId())
        const socketClientListeners = this.eventListeners.get(clientSocketId);
        const socketDealerListener = this.eventListeners.get(dealerSocketId)
        if (socketClientListeners||socketDealerListeners) {
            socketClientListeners.delete(event);  // Remove the specific listener
            socketDealerListeners.delete(event)
            if (socketClientListeners.size === 0) {
                this.eventListeners.delete(clientSocketId);  // Clean up if no listeners left
            }
            if (socketClientListeners.size === 0) {
                this.eventListeners.delete(dealerSocketId)  // Clean up if no listeners left
            }
        }
    }

    // Manually forward events between client and dealer
    private handleEventsAndPassToCP(event: string) {
        const dealerEvent = `${this.dealer.getId()}::${event}`;
        const clientEvent = `${this.client.getId()}::${event}`;

        // Forward events between client and dealer sockets
        this.dealer.on(dealerEvent, (data: SwapEvent) => this.client.send(dealerEvent, data));
        this.client.on(clientEvent, (data: SwapEvent) => this.dealer.send(clientEvent, data));
    }

}
