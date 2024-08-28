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
            var ltcToken = (0, market_factory_1.createToken)('TEST', 'TEST Token 2', 4);
            var testToken = (0, market_factory_1.createToken)('TEST2', 'TEST Token', 5);
            var ltcMartkets = [
                (0, market_factory_1.createMarket)(testToken, ltcToken, false),
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
        try {
            var wEthToken = (0, market_factory_1.createToken)('WETH', 'Wrapped ETH', 4);
            var wBtcToken = (0, market_factory_1.createToken)('WBTC', 'Wrapped BTC', 8);
            var usdToken = (0, market_factory_1.createToken)('USD', 'US Dollar', -3);
            var adaToken = (0, market_factory_1.createToken)('WADA', 'Cardano', 18);
            var usdContracts = [
                (0, market_factory_1.createContract)(adaToken, usdToken, 17, 'wADA/USD', adaToken, false),
                (0, market_factory_1.createContract)(wEthToken, usdToken, 5, 'wETH/USD', wEthToken, false),
                (0, market_factory_1.createContract)(wBtcToken, usdToken, 7, 'wBTC/USD', wBtcToken, true),
            ];
            var dogeContracts = [];
            var ltcMarketType = (0, market_factory_1.createMarketType)('USD', usdContracts, market_factory_1.MARKET_ICONS.USD, false);
            var dogeMarketType = (0, market_factory_1.createMarketType)('DOGE', dogeContracts, market_factory_1.MARKET_ICONS.DOGE, true);
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
