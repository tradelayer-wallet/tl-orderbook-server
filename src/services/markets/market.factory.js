"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MARKET_ICONS = exports.createMarketType = exports.createContract = exports.createMarket = exports.createToken = void 0;
var createToken = function (shortName, fullName, propertyId) {
    return { shortName: shortName, fullName: fullName, propertyId: propertyId };
};
exports.createToken = createToken;
var createMarket = function (first_token, second_token, disabled) {
    var pairString = "".concat(first_token.shortName, "/").concat(second_token.shortName);
    return { first_token: first_token, second_token: second_token, disabled: disabled, pairString: pairString };
};
exports.createMarket = createMarket;
var createContract = function (first_token, second_token, contract_id, contractName, collateral, disabled) {
    var pairString = "".concat(first_token.shortName, "/").concat(second_token.shortName);
    return { first_token: first_token, second_token: second_token, contract_id: contract_id, contractName: contractName, collateral: collateral, disabled: disabled, pairString: pairString };
};
exports.createContract = createContract;
var createMarketType = function (name, markets, icon, disabled) {
    return { name: name, markets: markets, icon: icon, disabled: disabled };
};
exports.createMarketType = createMarketType;
exports.MARKET_ICONS = {
    LTC: 'https://bitcoin-capital.bg/wp-content/uploads/2019/07/1920px-LTC-400-min-300x300.png',
    USD: 'https://cdn0.iconfinder.com/data/icons/mobile-device/512/dollar-usd-round-keyboard-money-usa-latin-2-512.png',
    ALL: 'https://cdn.discordapp.com/attachments/749975407838888058/817037799739490344/ALLFancyLogo.png',
    BTC: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/BTC_Logo.svg/2000px-BTC_Logo.svg.png',
    DOGE: 'https://logos-download.com/wp-content/uploads/2018/04/DogeCoin_logo_cercle-700x700.png',
};
