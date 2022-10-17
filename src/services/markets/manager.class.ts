import { IContract, IMarket, IMarketType } from "../../utils/types/markets.types";
import { IResult } from "../../utils/types/mix.types";
import { createContract, createMarket, createMarketType, createToken, MARKET_ICONS } from "./market.factory";

export class MarketsManager {
    constructor() {
        console.log(`Markets Service Initialized`);

    }

    getAvailableSpotMarkets(): IResult {
        try {
            const wEthToken = createToken('WETH', 'Wrapped ETH', 4);
            const wBtcToken = createToken('WBTC', 'Wrapped BTC', 17);

            const ltcToken = createToken('LTC', 'Litecoin', -1);
            const allToken = createToken('ALL', 'ALL', 1);
    
            const ltcMartkets: IMarket[] = [
                createMarket(wEthToken, ltcToken, false),
                createMarket(wBtcToken, ltcToken, false),
                createMarket(allToken, ltcToken, false),
            ];
        
            const usdMarkets: IMarket[] = [];
            const allMarkets:  IMarket[] = [
                createMarket(wEthToken, wBtcToken, false),
            ];
        
            const ltcMarketType = createMarketType('LTC', ltcMartkets, MARKET_ICONS.LTC, false);
            const usdMarketType = createMarketType('USD', usdMarkets, MARKET_ICONS.USD, true);
            const allMarketType = createMarketType('ALL', allMarkets, MARKET_ICONS.ALL, false);
            const result: IMarketType[] = [ ltcMarketType, usdMarketType, allMarketType ];
            return { data: result };
        } catch (error) {
            return { error: error.message };
        }
    }

    getAvailableFuturesMarkets(): IResult {
        try {
            const wEthToken = createToken('WETH', 'Wrapped ETH', 4);
            const wBtcToken = createToken('WBTC', 'Wrapped BTC', 8);
            const usdToken = createToken('USD', 'US Dollar', -3);

            const usdContracts: IContract[] = [
                createContract(wEthToken, usdToken, 5, 'wETH/USD', wEthToken, false),
                createContract(wBtcToken, usdToken, 7, 'wBTC/USD', wBtcToken, true),
            ];
            const dogeContracts: IContract[] = [];
        
            const ltcMarketType = createMarketType('USD', usdContracts, MARKET_ICONS.USD, false);
            const dogeMarketType = createMarketType('DOGE', dogeContracts, MARKET_ICONS.DOGE, true);
            const result: IMarketType[] = [ ltcMarketType, dogeMarketType ];
            return { data: result };
        } catch (error) {
            return { error: error.message };
        }
    }
}