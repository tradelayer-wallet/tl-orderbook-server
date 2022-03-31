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
            const ltcToken = createToken('LTC', 'LTC', -1);
            const allToken = createToken('ALL', 'ALL', 1);
    
            const ltcMartkets: IMarket[] = [
                createMarket(wEthToken, ltcToken, false),
                createMarket(allToken, ltcToken, false),
            ];
        
            const usdMarkets: IMarket[] = [];
            const allMarkets:  IMarket[] = [];
        
            const ltcMarketType = createMarketType('LTC', ltcMartkets, MARKET_ICONS.LTC, false);
            const usdMarketType = createMarketType('USD', usdMarkets, MARKET_ICONS.USD, true);
            const allMarketType = createMarketType('ALL', allMarkets, MARKET_ICONS.ALL, true);
            const result: IMarketType[] = [ ltcMarketType, usdMarketType, allMarketType ];
            return { data: result };
        } catch (error) {
            return { error: error.message };
        }
    }

    getAvailableFuturesMarkets(): IResult {
        try {
            const ltcContracts: IContract[] = [
                createContract(5, 'wETH/USD', 4, false),
                createContract(7, 'BTC/USD', 9, true),
            ];
            const btcContracts: IContract[] = [];
            const dogeContracts: IContract[] = [];
        
            const ltcMarketType = createMarketType('LTC', ltcContracts, MARKET_ICONS.LTC, false);
            const btcMarketType = createMarketType('BTC', btcContracts, MARKET_ICONS.BTC, true);
            const dogeMarketType = createMarketType('DOGE', dogeContracts, MARKET_ICONS.DOGE, true);
            const result: IMarketType[] = [ ltcMarketType, btcMarketType, dogeMarketType ];
            return { data: result };
        } catch (error) {
            return { error: error.message };
        }
    }
}