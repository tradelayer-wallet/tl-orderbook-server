import { EOrderType } from "./orderbook.types";

export interface IToken {
    shortName: string;
    fullName: string;
    propertyId: number| string;
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
    contract_id: number;
    contractName: string;
    collateral: IToken;
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
    contract_id: number,
}

export type TFilter = ISpotFilter | IFuturesFilter;
