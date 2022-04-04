import { EOrderType } from "./orderbook.types";

export interface IToken {
    shortName: string;
    fullName: string;
    propertyId: number;
}

export interface IMarket {
    first_token: IToken,
    second_token: IToken,
    disabled: boolean,
    pairString: string;
}

export interface IContract {
    first_token: IToken,
    second_token: IToken,
    contractId: number;
    contractName: string;
    collateral: number;
    disabled: boolean;
    pairString: string;
}

export interface IMarketType {
    name: string;
    markets: IMarket[] | IContract[];
    icon: string;
    disabled: boolean;
}

interface ISpotFilter {
    type: EOrderType.SPOT,
    first_token: number,
    second_token: number,
}

interface IFuturesFilter {
    type: EOrderType.FUTURES,
    contractId: number,
}

export type TFilter = ISpotFilter | IFuturesFilter;
