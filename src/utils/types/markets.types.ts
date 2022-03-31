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
    contractId: number;
    contractName: string;
    collateral: number;
    disabled: boolean;
}

export interface IMarketType {
    name: string;
    markets: IMarket[] | IContract[];
    icon: string;
    disabled: boolean;
}