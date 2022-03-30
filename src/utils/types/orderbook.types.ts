enum EOrderAction { 
    BUY = 'BUY',
    SELL = 'SELL',
}

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
        amount_desired: number,
        amount_for_sale: number,
    };
}

interface IRawFuturesOrder {
    keypair: IKeyPair;
    action: EOrderAction;
    type: EOrderType.FUTURES;
    props: {
        contract_id: number,
        // more ..
    };
}

interface IBuiltOrde {
    uuid: string;
    timestamp: number;
    socket_id: string;
}

interface ISpotOrder extends IRawSpotOrder, IBuiltOrde {}
interface IFuturesOrder extends IRawFuturesOrder, IBuiltOrde {}

export enum EOrderType {
    SPOT = 'SPOT',
    FUTURES = 'FUTURES',
}

export type TOrder = ISpotOrder | IFuturesOrder;
export type TRawOrder = IRawSpotOrder | IRawFuturesOrder;
