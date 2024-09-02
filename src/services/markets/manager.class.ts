import { IContract, IMarket, IMarketType } from "../../utils/types/markets.types";
import { IResult } from "../../utils/types/mix.types";
import { createContract, createMarket, createMarketType, createToken, MARKET_ICONS } from "./market.factory";

export class MarketsManager {
    constructor() {
        console.log(`Markets Service Initialized`);
    }

    getAvailableSpotMarkets(): IResult {
        try {
            const LTC = createToken('LTC', 'LTC', 0);
            const TBILL = createToken('TBILL', 'TBILL', 5);
            const TL = createToken('TL', 'TL', 1);
            const sLTC = createToken('sLTC', 'sLTC', 's-1-5');

            const ltcMarkets: IMarket[] = [
                createMarket(LTC, TBILL, false),
                createMarket(TL, LTC, false),
                createMarket(sLTC, LTC, false),
                createMarket(TL, TBILL, false),
                createMarket(sLTC, TBILL, false)
            ];

            const ltcMarketType = createMarketType('LTC', ltcMarkets, MARKET_ICONS.LTC, false);
            const result: IMarketType[] = [ltcMarketType];
            return { data: result };
        } catch (error) {
            return { error: error.message };
        }
    }

    getAvailableFuturesMarkets(): IResult {
        try {
            const LTC = createToken('LTC', 'Litecoin', 0);
            const TBILL = createToken('TBILL', 'US Treasury Bill', 5);
            const TL = createToken('TL', 'TradeLayer Native Metacoin', 1);
            const BTCoracle = createToken('BTC', 'Bitcoin Oracle', 1);

            const usdContracts: IContract[] = [
                createContract(TL, TBILL, 4, 'TL/TBILL', TBILL, false),
                createContract(LTC, TBILL, 5, 'LTC/TBILL', TBILL, false),
                createContract(BTCoracle, TBILL, 2, 'BTC/USD', TBILL, false)
            ];

            const ltcContracts: IContract[] = [
                createContract(TL, LTC, 1, 'TL/LTC', TL, false),
            ];

            const ltcMarketType = createMarketType('LTC', ltcContracts, MARKET_ICONS.LTC, false);
            const usdMarketType = createMarketType('USD', usdContracts, MARKET_ICONS.USD, true);
            const result: IMarketType[] = [ltcMarketType, usdMarketType];
            return { data: result };
        } catch (error) {
            return { error: error.message };
        }
    }
}
