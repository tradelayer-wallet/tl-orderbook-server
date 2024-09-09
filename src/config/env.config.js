"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.envConfig = void 0;
var dotenv = require("dotenv");
var path_1 = require("path");
var envFile = process.env.NODE_ENV === 'production' ? 'production.env' : 'development.env';
var path = (0, path_1.join)('environments', envFile);
dotenv.config({ path: path });
exports.envConfig = {
    SERVER_PORT: parseInt(process.env.SERVER_PORT),
};
