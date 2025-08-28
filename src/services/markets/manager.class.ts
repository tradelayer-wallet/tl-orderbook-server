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
            const USDT = createToken('USDT', 'USDT', 5);
            const TL = createToken('TL', 'TL', 1);
            const sLTC = createToken('sLTC', 'sLTC', 's1-5');
            const BTC = createToken('BTC', 'BTC',0)
            const sBTC = createToken('sBTC', 'BTC','s1-6')
            const TLTC = createToken('TLTC', 'TLTC',0)
            const USDTt = createToken('USDTt', 'USDTt',5)
            const tTL = createToken('TLt', 'TLt',1)
            const sLTCt = createToken('sLTCt', 'sLTCt','s1-5')

            const ltcMarkets: IMarket[] = [
                createMarket(LTC, USDT, false),
                createMarket(TL, LTC, false),
                createMarket(sLTC, LTC, false),
                createMarket(TL, USDT, false),
                createMarket(sLTC, USDT, false)
            ];

            const tltcMarkets: IMarket[] = [
                createMarket(TLTC, USDTt, false),
                createMarket(tTL, LTC, false),
                createMarket(sLTCt, LTC, false),
                createMarket(tTL, USDTt, false),
                createMarket(sLTCt, USDTt, false)
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
            const LTCoracle = createToken('LTC', 'Litecoin Oracle', 2)
            const sLTC = createToken('sLTC', 'Synth LTC', 's1-1')

            const usdContracts: IContract[] = [
            createContract(LTC, TBILL, 5, 'LTC/USDT', TBILL, false),
                createContract(TL, TBILL, 4, 'TL/USDT', TBILL, false),
                
                createContract(BTCoracle, TBILL, 2, 'BTC/USD', TBILL, false)
            ];

            const ltcContracts: IContract[] = [
                createContract(TL, LTC, 1, 'TL/LTC', TL, false),
            ];

            const btcContracts: IContract[] =[
                createContract(TL, BTC, 1, 'TL/BTC', TL, false)
            ]

             const usdMarketType = createMarketType('USD', usdContracts, MARKET_ICONS.USD, false);

            if(network=="LTC"||network=="LTCTEST"){
                const ltcMarketType = createMarketType('LTC', ltcContracts, MARKET_ICONS.LTC, false);

            const result: IMarketType[] = [usdMarketType, ltcMarketType];
            
            return { data: result };
            }
            
            if(network=="BTC"){
                const btcMarketType = createMarketType('BTC', btcContracts,MARKET_ICONS.BTC,false)

            const result: IMarketType[] = [usdMarketType,btcMarketType];
            
            return { data: result };
            }
        
        }
        catch (error) {
            return { error: error.message };
        }
    }
}
