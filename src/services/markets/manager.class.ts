import { IContract, IMarket, IMarketType } from "../../utils/types/markets.types";
import { IResult } from "../../utils/types/mix.types";
import { createContract, createMarket, createMarketType, createToken, MARKET_ICONS } from "./market.factory";

export class MarketsManager {
    constructor() {
        console.log(`Markets Service Initialized`);
    }

    // Correctly defined method
    getAvailableSpotMarkets(network:string): IResult<IMarketType[]> {
        try {
            const LTC = createToken('LTC', 'LTC', 0);
            const TBILL = createToken('TBILL', 'TBILL', 5);
            const TL = createToken('TL', 'TL', 1);
            const sLTC = createToken('sLTC', 'sLTC', 's-1-5');
            const BTC = createToken('BTC', 'BTC',0)
            const USDT = createToken('USDT', 'USDT',6)
            const sBTC = createToken('sBTC', 'BTC','s-1-6')
            const TLTC = createToken('TLTC', 'TLTC',0)
            const TBILLt = createToken('TBILLt', 'TBILLt',5)
            const tTL = createToken('TLt', 'TLt',1)
            const sLTCt = createToken('sLTCt', 'sLTCt','s-1-5')

            const ltcMarkets: IMarket[] = [
                createMarket(LTC, TBILL, false),
                createMarket(TL, LTC, false),
                createMarket(sLTC, LTC, false),
                createMarket(TL, TBILL, false),
                createMarket(sLTC, TBILL, false)
            ];

            const tltcMarkets: IMarket[] = [
                createMarket(TLTC, TBILLt, false),
                createMarket(tTL, LTC, false),
                createMarket(sLTCt, LTC, false),
                createMarket(tTL, TBILLt, false),
                createMarket(sLTCt, TBILLt, false)
            ];

            const btcMarkets: IMarket[] = [
                createMarket(BTC, USDT, false),
                createMarket(TL, BTC, false),
                createMarket(sBTC, BTC, false),
                createMarket(TL, USDT, false),
                createMarket(sBTC, USDT, false)
            ];

            if(network=="LTC"){
                const ltcMarketType = createMarketType('LTC', ltcMarkets, MARKET_ICONS.LTC, false);
                const result: IMarketType[] = [ltcMarketType];
                return { data: result };
            }

            if(network=="LTCTEST"){
                const tltcMarketType = createMarketType('TLTC', tltcMarkets, MARKET_ICONS.LTC, false);
                const result: IMarketType[] = [tltcMarketType];            
                return { data: result };
            }

            if(network=="BTC"){
                const btcMarketType = createMarketType('BTC', btcMarkets, MARKET_ICONS.BTC, false);
                const result: IMarketType[] = [btcMarketType];
                return { data: result };
            }
            
        }
        catch (error) {
            return { error: error.message };
        }
    }

    // Correctly defined method
    getAvailableFuturesMarkets(network:string): IResult<IMarketType[]> {
        try {
            const LTC = createToken('LTC', 'Litecoin', 0);
            const TBILL = createToken('TBILL', 'US Treasury Bill', 5);
            const TL = createToken('TL', 'TradeLayer Native Metacoin', 1);
            const BTCoracle = createToken('BTC', 'Bitcoin Oracle', 1);
            const BTC = createToken('BTC', 'BTC',0)


            const usdContracts: IContract[] = [
                createContract(TL, TBILL, 4, 'TL/TBILL', TBILL, false),
                createContract(LTC, TBILL, 5, 'LTC/TBILL', TBILL, false),
                createContract(BTCoracle, TBILL, 2, 'BTC/USD', TBILL, false)
            ];

            const ltcContracts: IContract[] = [
                createContract(TL, LTC, 1, 'TL/LTC', TL, false),
            ];

            const btcContracts: IContract[] =[
                createContract(TL, BTC, 1, 'TL/BTC', TL, false)
            ]

             const usdMarketType = createMarketType('USD', usdContracts, MARKET_ICONS.USD, true);

            if(network=="LTC"||network=="LTCTEST"){
                const ltcMarketType = createMarketType('LTC', ltcContracts, MARKET_ICONS.LTC, false);

            const result: IMarketType[] = [ltcMarketType, usdMarketType];
            
            return { data: result };
            }
            
            if(network=="BTC"){
                const btcMarketType = createMarketType('BTC', btcContracts,MARKET_ICONS.BTC,false)

            const result: IMarketType[] = [btcMarketType, usdMarketType];
            
            return { data: result };
            }
        
        }
        catch (error) {
            return { error: error.message };
        }
    }
}
