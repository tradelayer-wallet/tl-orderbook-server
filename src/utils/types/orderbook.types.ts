interface IKeyPair {
    address: string;
    pubkey: string;
}


interface IRawSpotOrder {
    keypair: IKeyPair;
    action: EOrderAction;
    type: EOrderType.SPOT;
    props: {
        id_desired: number,
        id_for_sale: number,
        amount: number,
        price: number,
    };
}

interface IRawFuturesOrder {
    keypair: IKeyPair;
    action: EOrderAction;
    type: EOrderType.FUTURES;
    props: {
        contract_id: number,
        amount: number,
        price: number,
        // more ..
    };
}

interface IBuiltOrde {
    uuid: string;
    timestamp: number;
    socket_id: string;
    lock: boolean;
}

interface ISpotOrder extends IRawSpotOrder, IBuiltOrde {}
interface IFuturesOrder extends IRawFuturesOrder, IBuiltOrde {}

export enum EOrderType {
    SPOT = 'SPOT',
    FUTURES = 'FUTURES',
}

export enum EOrderAction { 
    BUY = 'BUY',
    SELL = 'SELL',
}

export type TOrder = ISpotOrder | IFuturesOrder;
export type TRawOrder = IRawSpotOrder | IRawFuturesOrder;
