interface IKeyPair {
    address: string;
    pubkey: string;
};

export interface ISpotOrderProps {
    id_desired: number | string;
    id_for_sale: number | string;
    // Integer units (protocol-v2.md B.1): amount in 1e-8 whole tokens, price in sats per whole token.
    amount: number;
    price: number;
};

export interface IFuturesOrderProps {
    contract_id: number;
    amount: number;
    price: number;
    levarage: number;
    collateral: number;
};

interface IBuiltOrder {
    uuid: string;
    timestamp: number;
    socket_id: string;
    lock: boolean;
};

interface IRawSpotOrder {
    keypair: IKeyPair;
    action: EOrderAction;
    type: EOrderType.SPOT;
    isLimitOrder: boolean;
    marketName: string;
    props: ISpotOrderProps;
};

interface IRawFuturesOrder {
    keypair: IKeyPair;
    action: EOrderAction;
    type: EOrderType.FUTURES;
    isLimitOrder: boolean;
    marketName: string;
    props: IFuturesOrderProps;
};

interface ISpotOrder extends IRawSpotOrder, IBuiltOrder {};
interface IFuturesOrder extends IRawFuturesOrder, IBuiltOrder {};

export enum EOrderType {
    SPOT = 'SPOT',
    FUTURES = 'FUTURES',
};

export enum EOrderAction { 
    BUY = 'BUY',
    SELL = 'SELL',
};

export type TOrder = ISpotOrder | IFuturesOrder;

export interface IHistoryTrade extends ITradeInfo {
    txid: string;
    time: number;
};

interface ITradeClinetInfo {
    socketId: string;
    keypair: IKeyPair;
};

interface IFuturesTradeProps {
    amount: number;
    contract_id: number;
    price: number;
    levarage: number;
    collateral: number;
};

interface ISpotTradeProps {
    propIdDesired: number | string;
    propIdForSale: number | string;
    amountDesired: number;
    amountForSale: number;
    price: number;
};

export interface ITradeInfo {
    buyer: ITradeClinetInfo;
    seller: ITradeClinetInfo;
    taker: string;
    maker: string;
    props: IFuturesTradeProps | ISpotTradeProps;
    type: EOrderType;
};
