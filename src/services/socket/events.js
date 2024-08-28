"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderEmitEvents = exports.EmitEvents = exports.OnEvents = void 0;
exports.OnEvents = {
    CONNECTION: 'connection',
    DISCONNECT: 'disconnect',
    NEW_ORDER: 'new-order',
    MANY_ORDERS: 'many-orders',
    UPDATE_ORDERBOOK: 'update-orderbook',
    CLOSE_ORDER: 'close-order',
};
exports.EmitEvents = {
    ORDERBOOK_DATA: 'orderbook-data',
    PLACED_ORDERS: 'placed-orders',
    UPDATE_ORDERS_REQUEST: 'update-orders-request',
};
exports.OrderEmitEvents = {
    ERROR: 'order:error',
    SAVED: 'order:saved',
};
