"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoutes = void 0;
var logs_route_1 = require("./logs.route");
var markets_route_1 = require("./markets.route");
var handleRoutes = function (server) {
    server.register(require('fastify-cors'));
    server.register(markets_route_1.marketsRoutes, { prefix: '/markets' });
    server.register(logs_route_1.logsRoutes, { prefix: '/logs' });
};
exports.handleRoutes = handleRoutes;
