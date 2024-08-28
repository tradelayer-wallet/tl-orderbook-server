"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.socketService = exports.initSocketService = void 0;
var manager_class_1 = require("./manager.class");
var initSocketService = function (server) {
    exports.socketService = new manager_class_1.SocketManager(server);
};
exports.initSocketService = initSocketService;
