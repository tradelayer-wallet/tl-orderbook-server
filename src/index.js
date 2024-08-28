"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var fastify_1 = require("fastify");
var routes_1 = require("./routes/routes");
var env_config_1 = require("./config/env.config");
var socket_1 = require("./services/socket");
var orderbook_1 = require("./services/orderbook");
var markets_1 = require("./services/markets");
var PORT = Number(env_config_1.envConfig.SERVER_PORT) || 9191; // Default to 9191 if parsing fails//var PORT = env_config_1.envConfig.SERVER_PORT;
var OPTIONS = {};
var server = (0, fastify_1.default)(OPTIONS);
(0, routes_1.handleRoutes)(server);
(0, socket_1.initSocketService)(server);
(0, orderbook_1.initOrderbookService)();
(0, markets_1.initMarketsService)();
server
    .listen(PORT, '0.0.0.0')
    .then(function (serverUrl) {
    console.log("Server Started: http://localhost:".concat(PORT));
})
    .catch(function (error) {
    console.log({ error: error });
    server.log.error(error.message);
    process.exit(1);
});
