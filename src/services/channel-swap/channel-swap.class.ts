// channel-swap.class.ts
import { SocketEventManager } from './socket-event-manager';
import { IResultChannelSwap } from "../../utils/types/mix.types";
import { ITradeInfo, TOrder } from "../../utils/types/orderbook.types";
import { Websocket } from 'hyper-express';

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
    private clientManager: SocketEventManager;
    private dealerManager: SocketEventManager;
    private isClosed: boolean = false;

    constructor(
        private client: Websocket, 
        private dealer: Websocket, 
        private tradeInfo: ITradeInfo, 
        private unfilled: TOrder,
    ) {
        this.clientManager = new SocketEventManager(client);
        this.dealerManager = new SocketEventManager(dealer);
        this.onReady();
        this.openChannel();
    }

    onReady(): Promise<IResultChannelSwap> {
        return new Promise<IResultChannelSwap>((res) => {
            this.readyRes = res;
        });
    }

    private openChannel(): void {
        this.handleEvents();
        const buyerSocketId = this.tradeInfo.buyer.socketId;
        const trade = { tradeInfo: this.tradeInfo, unfilled: this.unfilled };
        const isBuyerClient = (this.client as any).id === buyerSocketId;

        // Send 'new-channel' event to both client and dealer
        this.clientManager.send('new-channel', { ...trade, isBuyer: isBuyerClient });
        this.dealerManager.send('new-channel', { ...trade, isBuyer: !isBuyerClient });
    }

    private handleEvents(): void {
        this.handleEventsAndPassToCounterparty();

        const onSwapEvent = (swapEvent: SwapEvent) => {
            const { eventName, socketId, data } = swapEvent;

            if (eventName === "BUYER:STEP6") {
                if (this.readyRes) this.readyRes({ data: { txid: data } });
                this.closeChannel();
            }

            if (eventName === "TERMINATE_TRADE") {
                if (this.readyRes) this.readyRes({ error: data, socketId });
                this.closeChannel();
            }
        };

        this.clientManager.on(swapEventName, onSwapEvent);
        this.dealerManager.on(swapEventName, onSwapEvent);
    }

    private handleEventsAndPassToCounterparty() {
        const clientId = (this.client as any).id;
        const dealerId = (this.dealer as any).id;

        const passToDealer = (data: any) => {
            this.dealerManager.send(`${clientId}::${swapEventName}`, data);
        };

        const passToClient = (data: any) => {
            this.clientManager.send(`${dealerId}::${swapEventName}`, data);
        };

        this.clientManager.on(`${clientId}::${swapEventName}`, passToDealer);
        this.dealerManager.on(`${dealerId}::${swapEventName}`, passToClient);
    }

    private closeChannel() {
        this.isClosed = true;
        // Remove event listeners
        this.clientManager.off(swapEventName, this.handleSwapEvent);
        this.dealerManager.off(swapEventName, this.handleSwapEvent);
        // Close the event managers
        this.clientManager.close();
        this.dealerManager.close();
    }

    // Added this method to avoid closure issues with 'this'
    private handleSwapEvent = (swapEvent: SwapEvent) => {
        // Implementation as above in handleEvents
    };
}
