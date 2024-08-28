"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.marketsManager = exports.initMarketsService = void 0;
var manager_class_1 = require("./manager.class");
var initMarketsService = function () {
    exports.marketsManager = new manager_class_1.MarketsManager();
};
exports.initMarketsService = initMarketsService;
