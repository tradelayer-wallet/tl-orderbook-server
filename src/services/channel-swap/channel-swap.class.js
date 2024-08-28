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
exports.ChannelSwap = void 0;
var SwapEvent = (function () {
    function SwapEvent(eventName, socketId, data) {
        this.eventName = eventName;
        this.socketId = socketId;
        this.data = data;
    }
    return SwapEvent;
}());
var swapEventName = 'swap';
var ChannelSwap = (function () {
    function ChannelSwap(client, dealer, tradeInfo, unfilled) {
        this.client = client;
        this.dealer = dealer;
        this.tradeInfo = tradeInfo;
        this.unfilled = unfilled;
        this.onReady();
        this.openChannel();
    }
    ChannelSwap.prototype.onReady = function () {
        var _this = this;
        return new Promise(function (res) {
            _this.readyRes = res;
        });
    };
    ChannelSwap.prototype.openChannel = function () {
        this.handleEvents();
        var buyerSocketId = this.tradeInfo.buyer.socketId;
        var trade = { tradeInfo: this.tradeInfo, unfilled: this.unfilled };
        this.client.emit('new-channel', __assign(__assign({}, trade), { isBuyer: this.client.id === buyerSocketId }));
        this.dealer.emit('new-channel', __assign(__assign({}, trade), { isBuyer: this.dealer.id === buyerSocketId }));
    };
    ChannelSwap.prototype.handleEvents = function () {
        var _this = this;
        this.removePreviuesEventListeners(swapEventName);
        this.handleEventsAndPassToCP(swapEventName);
        [this.client.id, this.dealer.id]
            .forEach(function (p) {
            [_this.dealer, _this.client]
                .forEach(function (c) {
                c.on("".concat(p, "::").concat(swapEventName), function (swapEvent) {
                    var eventName = swapEvent.eventName, data = swapEvent.data, socketId = swapEvent.socketId;
                    if (eventName === "BUYER:STEP6") {
                        if (_this.readyRes)
                            _this.readyRes({ data: { txid: data } });
                        _this.removePreviuesEventListeners(swapEventName);
                    }
                    if (eventName === "TERMINATE_TRADE") {
                        if (_this.readyRes)
                            _this.readyRes({ error: data, socketId: socketId });
                        _this.removePreviuesEventListeners(swapEventName);
                    }
                });
            });
        });
    };
    ChannelSwap.prototype.removePreviuesEventListeners = function (event) {
        this.client.removeAllListeners("".concat(this.client.id, "::").concat(event));
        this.dealer.removeAllListeners("".concat(this.dealer.id, "::").concat(event));
    };
    ChannelSwap.prototype.handleEventsAndPassToCP = function (event) {
        var _this = this;
        var dealerEvent = "".concat(this.dealer.id, "::").concat(event);
        var clientEvent = "".concat(this.client.id, "::").concat(event);
        this.dealer.on(dealerEvent, function (data) { return _this.client.emit(dealerEvent, data); });
        this.client.on(clientEvent, function (data) { return _this.dealer.emit(clientEvent, data); });
    };
    return ChannelSwap;
}());
exports.ChannelSwap = ChannelSwap;
