"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateOrderLog = exports.saveLog = exports.safeNumber = void 0;
var fs_1 = require("fs");
var moment = require("moment");
var safeNumber = function (n) { return parseFloat((n).toFixed(6)); };
exports.safeNumber = safeNumber;
;
var saveLog = function (name, type, data) {
    try {
        var date = moment().format('DD-MM-YYYY');
        var path = "logs/".concat(type, "-").concat(name, "-").concat(date, ".log");
        var _data = "".concat(JSON.stringify(data), "\n");
        (0, fs_1.appendFile)(path, _data, function (err) {
            if (err)
                throw new Error(err.message);
        });
    }
    catch (error) {
        console.log(error.message);
    }
};
exports.saveLog = saveLog;
var updateOrderLog = function (name, uuid, type) {
    try {
        var _path = "logs/";
        var data = (0, fs_1.readdirSync)(_path);
        var fileNamesList = data.filter(function (q) { return q.includes(name); });
        for (var i = 0; i < fileNamesList.length; i++) {
            var file = fileNamesList[i];
            var fileData = (0, fs_1.readFileSync)("".concat(_path).concat(file), { encoding: "utf8" });
            var arrayData = fileData.split("\n").slice(0, -1).map(function (q) { return JSON.parse(q); });
            var existing = arrayData.find(function (q) { return q.uuid === uuid; });
            if (existing) {
                existing['state'] = type;
                (0, fs_1.writeFileSync)("".concat(_path).concat(file), "".concat(arrayData.map(function (q) { return JSON.stringify(q); }).join('\n'), "\n"));
                break;
            }
        }
    }
    catch (error) {
        console.log({ error: error });
    }
};
exports.updateOrderLog = updateOrderLog;
