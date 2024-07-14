import { IContract, IMarket, IMarketType } from "../../utils/types/markets.types";
import { IResult } from "../../utils/types/mix.types";
import { createContract, createMarket, createMarketType, createToken, MARKET_ICONS } from "./market.factory";

export class MarketsManager {
    constructor() {
        console.log(`Markets Service Initialized`);

    }

    getAvailableSpotMarkets(): IResult {
        try {
            // const wEthToken = createToken('WETH', 'Wrapped ETH', 4);
            // const wBtcToken = createToken('WBTC', 'Wrapped BTC', 17);

            const ltcToken = createToken('TEST', 'TEST Token 2', 4);
            // const allToken = createToken('ALL', 'ALL', 1);
            // const adaToken = createToken('WADA', 'Wrapped Cardano', 18);
            const testToken = createToken('TEST2', 'TEST Token', 5);
            const ltcMartkets: IMarket[] = [
                createMarket(testToken, ltcToken, false),
                // createMarket(wBtcToken, ltcToken, false),
                // createMarket(allToken, ltcToken, false),
                // createMarket(adaToken, ltcToken, false),
            ];
        
            // const usdMarkets: IMarket[] = [];
            // const allMarkets:  IMarket[] = [
            //     createMarket(wEthToken, wBtcToken, false),
            // ];
        
            const ltcMarketType = createMarketType('LTC', ltcMartkets, MARKET_ICONS.LTC, false);
            // const usdMarketType = createMarketType('USD', usdMarkets, MARKET_ICONS.USD, true);
            // const allMarketType = createMarketType('ALL', allMarkets, MARKET_ICONS.ALL, true);
            // const result: IMarketType[] = [ ltcMarketType, usdMarketType, allMarketType ];
            const result: IMarketType[] = [ ltcMarketType ];
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
            const adaToken = createToken('WADA', 'Cardano', 18);

            const usdContracts: IContract[] = [
                createContract(adaToken, usdToken, 17, 'wADA/USD', adaToken, false),
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