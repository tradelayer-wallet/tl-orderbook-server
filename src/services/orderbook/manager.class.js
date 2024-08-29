"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderbookManager = void 0;
var orderbook_class_1 = require("./orderbook.class");
var mix_pure_1 = require("../../utils/pure/mix.pure");
var moment = require("moment");
var fs_1 = require("fs");
var OrderbookManager = (function () {
    function OrderbookManager() {
        this.orderbooks = [];
        console.log("Orderbook Service Initialized");
    }
    OrderbookManager.prototype.newOrderbook = function (firstOrder) {
        try {
            var orderbook = new orderbook_class_1.Orderbook(firstOrder);
            this.orderbooks.push(orderbook);
            orderbook.updatePlacedOrdersForSocketId(firstOrder.socket_id);
            return { data: { order: orderbook.orders[0] } };
        }
        catch (error) {
            return { error: error.message };
        }
    };
    OrderbookManager.prototype.addOrder = function (order, noTrades) {
        console.log('inside server add order '+JSON.stringify(order))
        if (noTrades === void 0) { noTrades = false; }
        return __awaiter(this, void 0, void 0, function () {
            var existingOrderbook, res, _a, error_1;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    console.log('b label '+_b.label)
                    case 0:
                        _b.trys.push([0, 4, , 5]);
                        existingOrderbook = this.orderbooks.find(function (b) { return b.checkCompatible(order); });
                        console.log('existing orderbook? '+JSON.stringify(existingOrderbook))
                        if (!existingOrderbook) return [3, 2];
                        return [4, existingOrderbook.addOrder(order, noTrades)];
                    case 1:
                        _a = _b.sent();
                        return [3, 3];
                    case 2:
                        _a = this.newOrderbook(order);
                        _b.label = 3;
                    case 3:
                        res = _a;
                        return [2, res];
                    case 4:
                        error_1 = _b.sent();
                        return [2, { error: error_1.message }];
                    case 5: return [2];
                }
            });
        });
    };
    OrderbookManager.prototype.removeOrder = function (uuid, socket_id) {
        try {
            var orderbook = this.orderbooks.find(function (b) { return b.orders.find(function (o) { return o.uuid === uuid; }); });
            if (!orderbook) {
                throw new Error("Order with uuid: ".concat(uuid, " dont exist"));
            }
            var order = orderbook.orders.find(function (q) { return q.uuid === uuid; });
            if (!order) {
                throw new Error("Order with uuid: ".concat(uuid, " dont exist"));
            }
            var res = orderbook.removeOrder(uuid, socket_id);
            (0, mix_pure_1.updateOrderLog)(orderbook.orderbookName, order.uuid, "CANCALED");
            return res;
        }
        catch (error) {
            return { error: error.message };
        }
    };
    OrderbookManager.prototype.getOrdersBySocketId = function (id) {
        var orders = [];
        this.orderbooks.forEach(function (ob) {
            ob.orders.forEach(function (o) {
                if (o.socket_id === id)
                    orders.push(o);
            });
        });
        return orders;
    };
    OrderbookManager.prototype.getOrdersHistory = function () {
        try {
            var _path_1 = "logs/";
            var today_1 = moment()
                .format('DD-MM-YYYY');
            var yesterday_1 = moment()
                .subtract(1, 'days')
                .format('DD-MM-YYYY');
            var files = (0, fs_1.readdirSync)(_path_1)
                .filter(function (f) { return f.startsWith('ORDER'); })
                .filter(function (f) { return f.includes(today_1) || f.includes(yesterday_1); });
            var resArray_1 = [];
            files.forEach(function (f) {
                var filePath = _path_1 + f;
                (0, fs_1.readFileSync)(filePath, 'utf8')
                    .split('\n')
                    .slice(0, -1)
                    .forEach(function (q) { return resArray_1.push(JSON.parse(q)); });
            });
            return resArray_1.slice(0, 500);
        }
        catch (error) {
            console.log(error);
            return [];
        }
    };
    return OrderbookManager;
}());
exports.OrderbookManager = OrderbookManager;
