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
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderFactory = void 0;
var uuid_1 = require("uuid");
var orderFactory = function (rawOrder, socket_id) {
    var timestamp = Date.now();
    var uuid = (0, uuid_1.v4)();
    var lock = false;
    var order = __assign(__assign({}, rawOrder), { timestamp: timestamp, uuid: uuid, socket_id: socket_id, lock: lock });
    return order;
};
exports.orderFactory = orderFactory;
