"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Orderbook = void 0;
var orderbook_types_1 = require("../../utils/types/orderbook.types");
var mix_pure_1 = require("../../utils/pure/mix.pure");
var socket_1 = require("../socket");
var channel_swap_class_1 = require("../channel-swap/channel-swap.class");
var _1 = require(".");
var events_1 = require("../socket/events");
var fs_1 = require("fs");
var Orderbook = (function () {
    function Orderbook(firstOrder) {
        this._orders = [];
        this._historyTrades = [];
        this.props = null;
        this._type = firstOrder.type;
        this.addProps(firstOrder);
        this.addOrder(firstOrder);
        this.addExistingTradesHistory();
    }
    Object.defineProperty(Orderbook.prototype, "type", {
        get: function () {
            return this._type;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(Orderbook.prototype, "orders", {
        get: function () {
            return this._orders;
        },
        set: function (value) {
            this._orders = value;
            socket_1.socketService.io.emit(events_1.EmitEvents.UPDATE_ORDERS_REQUEST);
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(Orderbook.prototype, "orderbookName", {
        get: function () {
            return this.type === orderbook_types_1.EOrderType.SPOT && 'id_desired' in this.props
                ? "spot_".concat(this.props.id_for_sale, "_").concat(this.props.id_desired)
                : this.type === orderbook_types_1.EOrderType.FUTURES && 'contract_id' in this.props
                    ? "futures-".concat(this.props.contract_id)
                    : null;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(Orderbook.prototype, "historyTrades", {
        get: function () {
            return this._historyTrades;
        },
        enumerable: false,
        configurable: true
    });
    Orderbook.prototype.addExistingTradesHistory = function () {
        try {
            var data_1 = [];
            var existingFiles = (0, fs_1.readdirSync)('logs');
            var names_1 = this.type === orderbook_types_1.EOrderType.SPOT && 'id_desired' in this.props && 'id_for_sale' in this.props
                ? ["spot_".concat(this.props.id_for_sale, "-").concat(this.props.id_desired), "spot_".concat(this.props.id_desired, "_").concat(this.props.id_for_sale)]
                : this.type === orderbook_types_1.EOrderType.FUTURES && 'contract_id' in this.props
                    ? ["futures-".concat(this.props.contract_id)]
                    : null;
            var currentOBTradeFiles = existingFiles.filter(function (q) {
                if (!q.startsWith('TRADE'))
                    return false;
                if (!names_1)
                    return false;
                return names_1.some(function (w) { return q.includes(w); });
            });
            currentOBTradeFiles.forEach(function (f) {
                var stringData = (0, fs_1.readFileSync)("logs/".concat(f), 'utf8');
                var arrayData = stringData
                    .split('\n')
                    .slice(0, -1)
                    .map(function (q) { return JSON.parse(q); });
                arrayData.forEach(function (d) { return data_1.push(d); });
            });
            this._historyTrades = data_1.slice(0, 2000);
            socket_1.socketService.io.emit(events_1.EmitEvents.UPDATE_ORDERS_REQUEST);
        }
        catch (error) {
            console.log({ error: error });
        }
    };
    Orderbook.prototype.addProps = function (order) {
        try {
            if (this.props) {
                throw new Error("Props for this orderbook already exist");
            }
            var type = order.type;
            if (type === orderbook_types_1.EOrderType.SPOT) {
                var _a = order.props, id_desired = _a.id_desired, id_for_sale = _a.id_for_sale;
                this.props = { id_desired: id_desired, id_for_sale: id_for_sale };
            }
            if (type === orderbook_types_1.EOrderType.FUTURES) {
                var contract_id = order.props.contract_id;
                this.props = { contract_id: contract_id };
            }
        }
        catch (error) {
            return { error: error.message };
        }
    };
    Orderbook.prototype.newChannel = function (tradeInfo, unfilled) {
        return __awaiter(this, void 0, void 0, function () {
            var buyerSocketId, sellerSocketId, buyerSocket, sellerSocket, channel, channelRes, historyTrade, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        buyerSocketId = tradeInfo.buyer.socketId;
                        sellerSocketId = tradeInfo.seller.socketId;
                        buyerSocket = socket_1.socketService.io.sockets.sockets.get(buyerSocketId);
                        sellerSocket = socket_1.socketService.io.sockets.sockets.get(sellerSocketId);
                        channel = new channel_swap_class_1.ChannelSwap(buyerSocket, sellerSocket, tradeInfo, unfilled);
                        return [4, channel.onReady()];
                    case 1:
                        channelRes = _a.sent();
                        if (channelRes.error || !channelRes.data)
                            return [2, channelRes];
                        historyTrade = __assign({ txid: channelRes.data.txid, time: Date.now() }, tradeInfo);
                        this.saveToHistory(historyTrade);
                        return [2, channelRes];
                    case 2:
                        error_1 = _a.sent();
                        return [2, { error: error_1.message }];
                    case 3: return [2];
                }
            });
        });
    };
    Orderbook.prototype.lockOrder = function (order, lock) {
        if (lock === void 0) { lock = true; }
        order.lock = lock;
        socket_1.socketService.io.emit(events_1.EmitEvents.UPDATE_ORDERS_REQUEST);
    };
    Orderbook.prototype.saveToHistory = function (historyTrade) {
        this._historyTrades = __spreadArray([historyTrade], this.historyTrades.slice(0, 1999), true);
        (0, mix_pure_1.saveLog)(this.orderbookName, "TRADE", historyTrade);
        socket_1.socketService.io.emit(events_1.EmitEvents.UPDATE_ORDERS_REQUEST);
    };
    Orderbook.prototype.updatePlacedOrdersForSocketId = function (socketid) {
        var openedOrders = _1.orderbookManager.getOrdersBySocketId(socketid);
        var orderHistory = _1.orderbookManager.getOrdersHistory();
        var socketObj = socket_1.socketService.io.sockets.sockets.get(socketid);
        socketObj.emit(events_1.EmitEvents.PLACED_ORDERS, { openedOrders: openedOrders, orderHistory: orderHistory });
    };
    Orderbook.prototype.checkMatch = function (order) {
        try {
            var props = order.props, action = order.action;
            var price_1 = props.price;
            var sortFunc = action === orderbook_types_1.EOrderAction.BUY
                ? function (a, b) { return a.props.price - b.props.price; }
                : function (a, b) { return b.props.price - a.props.price; };
            var filteredOrders = this.orders.filter(function (o) {
                var idChecks = o.type === orderbook_types_1.EOrderType.SPOT && order.type === orderbook_types_1.EOrderType.SPOT
                    ? o.props.id_desired === order.props.id_for_sale && o.props.id_for_sale === order.props.id_desired
                    : o.type === orderbook_types_1.EOrderType.FUTURES && order.type === orderbook_types_1.EOrderType.FUTURES
                        ? o.props.contract_id === order.props.contract_id
                        : false;
                var buySellCheck = order.action === orderbook_types_1.EOrderAction.BUY
                    ? o.action === orderbook_types_1.EOrderAction.SELL
                    : order.action === orderbook_types_1.EOrderAction.SELL
                        ? o.action === orderbook_types_1.EOrderAction.BUY
                        : false;
                var priceCheck = order.action === orderbook_types_1.EOrderAction.BUY
                    ? o.props.price <= price_1
                    : order.action === orderbook_types_1.EOrderAction.SELL
                        ? o.props.price >= price_1
                        : false;
                var lockCheck = !o.lock;
                return idChecks && buySellCheck && priceCheck && lockCheck && lockCheck;
            }).sort(sortFunc);
            if (filteredOrders.length) {
                var matchOrder = filteredOrders[0];
                if (matchOrder.socket_id === order.socket_id) {
                    throw new Error("Match of the order from the same Account");
                }
                if (matchOrder.keypair.address === order.keypair.address) {
                    throw new Error("Match of the order from the same address");
                }
                return { data: { match: matchOrder } };
            }
            return { data: { match: null } };
        }
        catch (error) {
            return { error: error.message };
        }
    };
    Orderbook.prototype.addOrder = function (order, noTrades) {
        var _a, _b;
        if (noTrades === void 0) { noTrades = false; }
        return __awaiter(this, void 0, void 0, function () {
            var matchRes, buildTradeRes, newChannelRes, res, error_2;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        _c.trys.push([0, 6, , 7]);
                        if (!this.checkCompatible(order)) {
                            throw new Error("Order missmatch current orderbook interface or type");
                        }
                        matchRes = this.checkMatch(order);
                        if (matchRes.error || !matchRes.data)
                            throw new Error("".concat(matchRes.error || "Undefined Error"));
                        if (!!matchRes.data.match) return [3, 1];
                        (0, mix_pure_1.saveLog)(this.orderbookName, "ORDER", order);
                        this.orders = __spreadArray(__spreadArray([], this.orders, true), [order], false);
                        this.updatePlacedOrdersForSocketId(order.socket_id);
                        return [2, { data: { order: order } }];
                    case 1:
                        if (noTrades)
                            return [2];
                        this.lockOrder(matchRes.data.match);
                        (0, mix_pure_1.updateOrderLog)(this.orderbookName, matchRes.data.match.uuid, 'FILLED');
                        buildTradeRes = buildTrade(order, matchRes.data.match);
                        if (buildTradeRes.error || !buildTradeRes.data) {
                            throw new Error("".concat(buildTradeRes.error || "Building Trade Failed. Code 2"));
                        }
                        return [4, this.newChannel(buildTradeRes.data.tradeInfo, buildTradeRes.data.unfilled)];
                    case 2:
                        newChannelRes = _c.sent();
                        if (newChannelRes.error || !newChannelRes.data) {
                            matchRes.data.match.socket_id !== newChannelRes.socketId
                                ? this.lockOrder(matchRes.data.match, false)
                                : this.removeOrder(matchRes.data.match.uuid, matchRes.data.match.socket_id);
                            this.updatePlacedOrdersForSocketId(matchRes.data.match.socket_id);
                            throw new Error("".concat(newChannelRes.error || "Undefined Error"));
                        }
                        if (((_a = buildTradeRes.data.unfilled) === null || _a === void 0 ? void 0 : _a.uuid) === matchRes.data.match.uuid) {
                            matchRes.data.match.props.amount = buildTradeRes.data.unfilled.props.amount;
                            this.lockOrder(matchRes.data.match, false);
                        }
                        else {
                            this.removeOrder(matchRes.data.match.uuid, matchRes.data.match.socket_id);
                        }
                        this.updatePlacedOrdersForSocketId(matchRes.data.match.socket_id);
                        if (!(((_b = buildTradeRes.data.unfilled) === null || _b === void 0 ? void 0 : _b.uuid) === order.uuid)) return [3, 4];
                        return [4, this.addOrder(buildTradeRes.data.unfilled)];
                    case 3:
                        res = _c.sent();
                        return [2, { data: res.data }];
                    case 4:
                        this.updatePlacedOrdersForSocketId(order.socket_id);
                        return [2, { data: { trade: newChannelRes.data } }];
                    case 5: return [3, 7];
                    case 6:
                        error_2 = _c.sent();
                        return [2, { error: error_2.message }];
                    case 7: return [2];
                }
            });
        });
    };
    Orderbook.prototype.findByFilter = function (filter) {
        if (!this.props)
            return false;
        if (filter.type !== this.type)
            return false;
        if (filter.type === orderbook_types_1.EOrderType.SPOT && 'id_desired' in this.props) {
            var checkA = filter.first_token === this.props.id_desired
                && filter.second_token === this.props.id_for_sale;
            var checkB = filter.first_token === this.props.id_for_sale
                && filter.second_token === this.props.id_desired;
            return checkA || checkB;
        }
        if (filter.type === orderbook_types_1.EOrderType.FUTURES && 'contract_id' in this.props) {
            return filter.contract_id === this.props.contract_id;
        }
        return false;
    };
    Orderbook.prototype.checkCompatible = function (order) {
        if (!this.props)
            return false;
        if (order.type !== this.type)
            return false;
        if (order.type === orderbook_types_1.EOrderType.SPOT && 'id_desired' in this.props) {
            var checkA = order.props.id_desired === this.props.id_desired
                && order.props.id_for_sale === this.props.id_for_sale;
            var checkB = order.props.id_desired === this.props.id_for_sale
                && order.props.id_for_sale === this.props.id_desired;
            return checkA || checkB;
        }
        if (order.type === orderbook_types_1.EOrderType.FUTURES && 'contract_id' in this.props) {
            return order.props.contract_id === this.props.contract_id;
        }
        return false;
    };
    Orderbook.prototype.removeOrder = function (uuid, socket_id) {
        try {
            var orderForRemove_1 = this.orders.find(function (o) { return o.uuid === uuid; });
            if (!orderForRemove_1) {
                throw new Error("Order with uuid ".concat(uuid, " dont exist in current orderbook"));
            }
            if (socket_id !== orderForRemove_1.socket_id) {
                throw new Error("Not Authorized to remove order with uuid: ".concat(uuid));
            }
            this.orders = this.orders.filter(function (o) { return o !== orderForRemove_1; });
            return { data: "Order with uuid ".concat(uuid, " was removed!") };
        }
        catch (error) {
            return { error: error.message };
        }
    };
    return Orderbook;
}());
exports.Orderbook = Orderbook;
var buildTrade = function (new_order, old_order) {
    try {
        var ordersArray = [new_order, old_order];
        var buyOrder = ordersArray.find(function (t) { return t.action === orderbook_types_1.EOrderAction.BUY; });
        var sellOrder = ordersArray.find(function (t) { return t.action === orderbook_types_1.EOrderAction.SELL; });
        if (!buyOrder || !sellOrder)
            throw new Error("Building Trade Failed. Code 1");
        var newOrderAmount = new_order.props.amount;
        var oldOrderAmount = old_order.props.amount;
        var unfilled = (newOrderAmount > oldOrderAmount
            ? __assign(__assign({}, new_order), { props: __assign(__assign({}, new_order.props), { amount: (0, mix_pure_1.safeNumber)(newOrderAmount - oldOrderAmount) }) }) : newOrderAmount < oldOrderAmount
            ? __assign(__assign({}, old_order), { props: __assign(__assign({}, old_order.props), { amount: (0, mix_pure_1.safeNumber)(oldOrderAmount - newOrderAmount) }) }) : null);
        var amount = Math.min(newOrderAmount, oldOrderAmount);
        var price = old_order.props.price;
        var tradeInfo = {
            type: new_order.type,
            buyer: {
                socketId: buyOrder.socket_id,
                keypair: {
                    address: buyOrder.keypair.address,
                    pubkey: buyOrder.keypair.pubkey,
                },
            },
            seller: {
                socketId: sellOrder.socket_id,
                keypair: {
                    address: sellOrder.keypair.address,
                    pubkey: sellOrder.keypair.pubkey,
                }
            },
            taker: new_order.socket_id,
            maker: old_order.socket_id,
            props: buyOrder.type === orderbook_types_1.EOrderType.FUTURES
                ? {
                    amount: amount,
                    contract_id: buyOrder.props.contract_id,
                    price: price,
                    levarage: buyOrder.props.levarage,
                    collateral: buyOrder.props.collateral,
                }
                : {
                    propIdDesired: buyOrder.props.id_desired,
                    propIdForSale: buyOrder.props.id_for_sale,
                    amountDesired: amount,
                    amountForSale: (0, mix_pure_1.safeNumber)(amount * price),
                }
        };
        return { data: { unfilled: unfilled, tradeInfo: tradeInfo } };
    }
    catch (error) {
        return { error: error.message };
    }
};
