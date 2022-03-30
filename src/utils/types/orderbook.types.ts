enum EOrderAction { 
    BUY = 'BUY',
    SELL = 'SELL',
}

interface IKeyPair {
    address: string;
    pubkey: string;
}

interface IBaseOrder {
    uuid: string;
    timestamp: number;
    socket_id: string;
    keypair: IKeyPair;
    action: EOrderAction;
}

interface ISpotOrder extends IBaseOrder {
    type: EOrderType.SPOT;
    props: {
        id_desired: number,
        id_for_sale: number,
        amount_desired: number,
        amount_for_sale: number,
    };
}

interface IFuturesOrder extends IBaseOrder {
    type: EOrderType.FUTURES;
    props: {
        contract_id: number,
        // more ..
    };
}

export enum EOrderType {
    SPOT = 'SPOT',
    FUTURES = 'FUTURES',
}

export type TOrder = ISpotOrder | IFuturesOrder;

