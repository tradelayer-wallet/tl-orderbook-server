"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketsManager = void 0;
var market_factory_1 = require("./market.factory");
var MarketsManager = (function () {
    function MarketsManager() {
        console.log("Markets Service Initialized");
    }
    MarketsManager.prototype.getAvailableSpotMarkets = function () {
        try {
            var LTC = (0, market_factory_1.createToken)('LTC', 'LTC', 0);
            var TBILL = (0, market_factory_1.createToken)('TBILL', 'TBILL', 5);
            var TL = (0, market_factory_1.createToken)('TL','TL',1)
            var sLTC = (0, market_factory_1.createToken)('sLTC','sLTC','s-1-5')
            var ltcMartkets = [
                (0, market_factory_1.createMarket)(LTC, TBILL, false),
                (0, market_factory_1.createMarket)(TL, LTC, false),
                (0, market_factory_1.createMarket)(sLTC, LTC, false),
                (0, market_factory_1.createMarket)(TL, TBILL, false),
                (0, market_factory_1.createMarket)(sLTC, TBILL, false)
            ];
            var ltcMarketType = (0, market_factory_1.createMarketType)('LTC', ltcMartkets, market_factory_1.MARKET_ICONS.LTC, false);
            var result = [ltcMarketType];
            return { data: result };
        }
        catch (error) {
            return { error: error.message };
        }
    };
    MarketsManager.prototype.getAvailableFuturesMarkets = function () {
            var LTC = (0, market_factory_1.createToken)('LTC', 'Litecoin', 0);
            var TBILL = (0, market_factory_1.createToken)('TBILL', 'US Treasury Bill', 5);
            var TL = (0, market_factory_1.createToken)('TL','TradeLayer Native Metacoin',1)
            var BTCoracle = (0, market_factory_1.createToken)('BTC','Bitcoin Oracle',1)
        try {
            var usdContracts = [
                (0, market_factory_1.createContract)(TL, TBILL, 4, 'TL/TBILL', TBILL, false),
                (0, market_factory_1.createContract)(LTC, TBILL, 5, 'LTC/TBILL', TBILL, false),
                (0, market_factory_1.createContract)(BTCoracle, TBILL, 2, 'BTC/USD', TBILL, false)
            ];
            var ltcContracts = [
                (0, market_factory_1.createContract)(TL, LTC, 1, 'TL/LTC', TL, false),
            ]
            //var dogeContracts = [];
            var ltcMarketType = (0, market_factory_1.createMarketType)('LTC', ltcContracts, market_factory_1.MARKET_ICONS.LTC, false);
            var usdMarketType = (0, market_factory_1.createMarketType)('USD', usdContracts, market_factory_1.MARKET_ICONS.USD, true);
            var result = [ltcMarketType, dogeMarketType];
            return { data: result };
        }
        catch (error) {
            return { error: error.message };
        }
    };
    return MarketsManager;
}());
exports.MarketsManager = MarketsManager;
