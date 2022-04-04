import { Socket } from "socket.io";
import { IResult } from "../../utils/types/mix.types";

export class ChannelSwap {
    private readyRes: (value: IResult) => void;
    constructor(
        private client: Socket, 
        private dealer: Socket, 
        private trade: any, 
        private isFilled: boolean,
    ) {
        this.onReady();
        this.openChannel();
    }

    onReady() {
        return new Promise<IResult>((res) => {
            this.readyRes = res;
        });
    }

    private openChannel(): void {
        this.handleEvents();
        const { buyerSocketId } = this.trade;
        const trade = { ...this.trade, filled: this.isFilled };
        this.client.emit('new-channel', { ...trade, buyer: this.client.id === buyerSocketId });
        this.dealer.emit('new-channel', { ...trade, buyer: this.dealer.id === buyerSocketId });
    }

    private handleEvents(): void {
        const eventsArray = [
            'TERMINATE_TRADE',
            'SELLER:MS_DATA',
            'SELLER:COMMIT_UTXO' ,
            'SELLER:SIGNED_RAWTX',
            'BUYER:COMMIT',
            'BUYER:RAWTX',
            'BUYER:FINALTX',
        ];
        eventsArray.forEach(e => this.removePreviuesEventListeners(e));
        eventsArray.forEach(e => this.handleEventsAndPassToCP(e));

        this.client.on(`${this.client.id}::BUYER:FINALTX`, (finalTx) => {
            if (this.readyRes) this.readyRes({ data: { txid: finalTx } });
            eventsArray.forEach(e => this.removePreviuesEventListeners(e));
        });

        this.dealer.on(`${this.dealer.id}::BUYER:FINALTX`, (finalTx) => {
            if (this.readyRes) this.readyRes({ data: { txid: finalTx } });
            eventsArray.forEach(e => this.removePreviuesEventListeners(e));
        });
        
        this.client.on(`${this.client.id}::TERMINATE_TRADE`, (reason) => {
            if (this.readyRes) this.readyRes({ error: reason });
            eventsArray.forEach(e => this.removePreviuesEventListeners(e));
        });

        this.dealer.on(`${this.dealer.id}::TERMINATE_TRADE`, (reason) => {
            if (this.readyRes) this.readyRes({ error: reason });
            eventsArray.forEach(e => this.removePreviuesEventListeners(e));
        });
    }

    private removePreviuesEventListeners(event: string) {
        this.client.removeAllListeners(`${this.client.id}::${event}`);
        this.dealer.removeAllListeners(`${this.dealer.id}::${event}`);
    }

    private handleEventsAndPassToCP(event: string) {
        const dealerEvent = `${this.dealer.id}::${event}`;
        const clientEvent = `${this.client.id}::${event}`;
        this.dealer.on(dealerEvent, (data) => this.client.emit(dealerEvent, this.dealer.id, data));
        this.client.on(clientEvent, (data) => this.dealer.emit(clientEvent, this.client.id, data));
    }
}