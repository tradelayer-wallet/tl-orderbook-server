"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderbookManager = exports.initOrderbookService = void 0;
var manager_class_1 = require("./manager.class");
var initOrderbookService = function () {
    exports.orderbookManager = new manager_class_1.OrderbookManager();
};
exports.initOrderbookService = initOrderbookService;
