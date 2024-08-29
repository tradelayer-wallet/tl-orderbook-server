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
exports.SocketManager = void 0;
var orderbook_1 = require("../orderbook");
var order_factory_1 = require("../orderbook/order.factory");
var events_1 = require("./events");
;
var SocketManager = (function () {
    function SocketManager(server) {
        this.server = server;
        this._liveSessions = [];
        this.initService();
    }
    Object.defineProperty(SocketManager.prototype, "io", {
        get: function () {
            return this.server['io'];
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(SocketManager.prototype, "liveSessions", {
        get: function () {
            return this._liveSessions;
        },
        enumerable: false,
        configurable: true
    });
    SocketManager.prototype.initService = function () {
        var _this = this;
        var fastifyIO = require("fastify-socket.io");
        this.server.register(fastifyIO);
        this.server.ready().then(function () {
            console.log("Socket Service Initialized");
            _this.io.on(events_1.OnEvents.CONNECTION, onConnection);
            _this.io.on(events_1.OnEvents.CONNECTION, _this.handleLiveSessions.bind(_this));
        });
    };
    SocketManager.prototype.handleLiveSessions = function (socket) {
        var _this = this;
        this._liveSessions.push({
            id: socket.id,
            startTime: Date.now(),
            ip: socket.client.conn.remoteAddress,
        });
        socket.on(events_1.OnEvents.DISCONNECT, function () {
            _this._liveSessions = _this._liveSessions.filter(function (q) { return q.id !== socket.id; });
        });
    };
    return SocketManager;
}());
exports.SocketManager = SocketManager;
var onConnection = function (socket) {
    console.log("New Connection: ".concat(socket.id));
    socket.on(events_1.OnEvents.DISCONNECT, onDisconnect(socket));
    socket.on(events_1.OnEvents.NEW_ORDER, onNewOrder(socket));
    socket.on(events_1.OnEvents.UPDATE_ORDERBOOK, onUpdateOrderbook(socket));
    socket.on(events_1.OnEvents.CLOSE_ORDER, onClosedOrder(socket));
    socket.on(events_1.OnEvents.MANY_ORDERS, onManyOrders(socket));
};
var onManyOrders = function (socket) { return function (rawOrders) { return __awaiter(void 0, void 0, void 0, function () {
    var i, rawOrder, order;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                i = 0;
                _a.label = 1;
            case 1:
                if (!(i < rawOrders.length)) return [3, 4];
                rawOrder = rawOrders[i];
                order = (0, order_factory_1.orderFactory)(rawOrder, socket.id);
                return [4, orderbook_1.orderbookManager.addOrder(order, true)];
            case 2:
                _a.sent();
                _a.label = 3;
            case 3:
                i++;
                return [3, 1];
            case 4:
                socket.emit(events_1.OrderEmitEvents.SAVED);
                return [2];
        }
    });
}); }; };
var onDisconnect = function (socket) { return function (reason) {
    var openedOrders = orderbook_1.orderbookManager.getOrdersBySocketId(socket.id);
    openedOrders.forEach(function (o) { return orderbook_1.orderbookManager.removeOrder(o.uuid, socket.id); });
    console.log("".concat(socket.id, " Disconnected! Reason: ").concat(reason));
}; };
var onNewOrder = function (socket) { return function (rawOrder) { return __awaiter(void 0, void 0, void 0, function () {
    var order, res;
    return __generator(this, function (_a) {
        switch (_a.label) {
                
            case 0:
            console.log('inside new order in server '+_a.label)
                if (!rawOrder.isLimitOrder) {
                    socket.emit(events_1.OrderEmitEvents.ERROR, 'Market Orders Not allowed');
                    return [2];
                }
                order = (0, order_factory_1.orderFactory)(rawOrder, socket.id);
                console.log('order '+order)
                return [4, orderbook_1.orderbookManager.addOrder(order)];
            case 1:
            console.log('inside new order in server '+_a.label)
                res = _a.sent();
                if (res.error || !res.data) {
                    socket.emit(events_1.OrderEmitEvents.ERROR, res.error || 'Undefined Error');
                    return [2];
                }
                if (res.data.order)
                    socket.emit(events_1.OrderEmitEvents.SAVED, res.data.order.uuid);
                return [2];
        }
    });
}); }; };
var onUpdateOrderbook = function (socket) { return function (filter) { return __awaiter(void 0, void 0, void 0, function () {
    var orderbook, orders, history;
    return __generator(this, function (_a) {
        orderbook = orderbook_1.orderbookManager.orderbooks.find(function (e) { return e.findByFilter(filter); });
        orders = orderbook ? orderbook.orders.filter(function (o) { return !o.lock; }) : [];
        history = orderbook ? orderbook.historyTrades.filter(function (o) { return o.txid; }) : [];
        socket.emit(events_1.EmitEvents.ORDERBOOK_DATA, { orders: orders, history: history });
        return [2];
    });
}); }; };
var onClosedOrder = function (socket) { return function (orderUUID) {
    var res = orderbook_1.orderbookManager.removeOrder(orderUUID, socket.id);
    var openedOrders = orderbook_1.orderbookManager.getOrdersBySocketId(socket.id);
    var orderHistory = orderbook_1.orderbookManager.getOrdersHistory();
    socket.emit(events_1.EmitEvents.PLACED_ORDERS, { openedOrders: openedOrders, orderHistory: orderHistory });
}; };
