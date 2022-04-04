import { IContract, IMarket, IMarketType, IToken } from "../../utils/types/markets.types";

export const createToken = (shortName: string, fullName: string, propertyId: number): IToken => {
    return { shortName, fullName, propertyId };
};

export const createMarket = (first_token: IToken, second_token: IToken, disabled: boolean): IMarket => {
    const pairString = `${first_token.shortName}/${second_token.shortName}`;
    return { first_token, second_token, disabled, pairString };
};

export const createContract = (first_token: IToken, second_token: IToken, contractId: number, contractName: string, collateral: number, disabled: boolean): IContract => {
    const pairString = `${first_token.shortName}/${second_token.shortName}`;
    return { first_token, second_token, contractId, contractName, collateral, disabled, pairString };
};

export const createMarketType = (name: string, markets: IMarket[] | IContract[], icon: string, disabled: boolean): IMarketType => {
    return { name, markets, icon, disabled };
};

export const MARKET_ICONS = {
    LTC: 'https://bitcoin-capital.bg/wp-content/uploads/2019/07/1920px-LTC-400-min-300x300.png',
    USD: 'https://cdn0.iconfinder.com/data/icons/mobile-device/512/dollar-usd-round-keyboard-money-usa-latin-2-512.png',
    ALL: 'https://cdn.discordapp.com/attachments/749975407838888058/817037799739490344/ALLFancyLogo.png',
    BTC: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/BTC_Logo.svg/2000px-BTC_Logo.svg.png',
    DOGE: 'https://logos-download.com/wp-content/uploads/2018/04/DogeCoin_logo_cercle-700x700.png',
};
