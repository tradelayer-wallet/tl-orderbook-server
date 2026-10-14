import { 
    EOrderAction,
    EOrderType,
    IFuturesOrderProps,
    IHistoryTrade,
    ISpotOrderProps,
    ITradeInfo,
    TOrder,
} from "../../utils/types/orderbook.types";
import { IResult, IResultChannelSwap } from "../../utils/types/mix.types";
import { isNonNegativeSafeInteger, isValidOrderIdProp, mulDivUnits, saveLog, toUnits, UNIT_SCALE, updateOrderLog } from "../../utils/pure/mix.pure";
import { socketService } from "../socket";
import { ChannelSwap, resolveSwapParticipants } from "../channel-swap/channel-swap.class";
import { TFilter } from "../../utils/types/markets.types";
import { orderbookManager } from ".";
import { EmitEvents } from "../socket/events";
import { readdirSync, readFileSync } from "fs";

export class Orderbook {
    private _type: EOrderType;
    private _orders: TOrder[] = [];
    private _historyTrades: IHistoryTrade[] = [];
    private props: ISpotOrderProps | IFuturesOrderProps = null;

    constructor(firstOrder: TOrder) {
        this._type = firstOrder.type;
        this.addProps(firstOrder);
        this.addOrder(firstOrder);
        this.addExistingTradesHistory();
    }

    private get type(): EOrderType {
        return this._type;
    }

    set orders(value: TOrder[]) {
        this._orders = value;
        socketService.io.emit(EmitEvents.UPDATE_ORDERS_REQUEST);
    }

    get orderbookName() {
        return this.type === EOrderType.SPOT && 'id_desired' in this.props
        ? `spot_${this.props.id_for_sale}_${(this.props as ISpotOrderProps).id_desired}`
        : this.type === EOrderType.FUTURES && 'contract_id' in this.props
            ? `futures-${this.props.contract_id}`
            : null;
    }

    get orders(): TOrder[] {
        return this._orders;
    }

    get historyTrades() {
        return this._historyTrades;
    }

    private addExistingTradesHistory() {
        try {
            const data: IHistoryTrade[] = [];
            const existingFiles = readdirSync('logs');
            const names = this.type === EOrderType.SPOT && 'id_desired' in this.props && 'id_for_sale' in this.props
            ? [`spot_${this.props.id_for_sale}-${this.props.id_desired}`, `spot_${this.props.id_desired}_${this.props.id_for_sale}`]
            : this.type === EOrderType.FUTURES && 'contract_id' in this.props
                ? [`futures-${this.props.contract_id}`]
                : null;
            const currentOBTradeFiles = existingFiles.filter(q => {
                if (!q.startsWith('TRADE')) return false;
                if (!names) return false;
                return names.some(w => q.includes(w));
            });
            currentOBTradeFiles.forEach(f => {
                const stringData = readFileSync(`logs/${f}`, 'utf8');
                const arrayData = stringData
                    .split('\n')
                    .slice(0, -1)
                    .map(q => JSON.parse(q) as IHistoryTrade);
                arrayData.forEach(d => data.push(d));
            });
            this._historyTrades = data.slice(0, 2000);
            socketService.io.emit(EmitEvents.UPDATE_ORDERS_REQUEST);
        } catch (error) {
            console.log({ error });
        }
    }

    private addProps(order: TOrder): void {
        const propsError = validateOrderbookNameProps(order);
        if (propsError) throw new Error(propsError);

        if (this.props) {
            throw new Error(`Props for this orderbook already exist`);
        }

        const { type } = order;
        if (type === EOrderType.SPOT) {
            const { id_desired, id_for_sale } = order.props;
            this.props = { id_desired, id_for_sale } as ISpotOrderProps;
        }

        if (type === EOrderType.FUTURES) {
            const { contract_id } = order.props;
            this.props = { contract_id } as IFuturesOrderProps;
        }
    }

    private async newChannel(tradeInfo: ITradeInfo, unfilled: TOrder): Promise<IResultChannelSwap> {
        try {
            const participants = resolveSwapParticipants(socketService.io, tradeInfo);
            if (participants.error || !participants.data) {
                return { error: participants.error || 'Counterparty is not connected' };
            }
            const channel = new ChannelSwap(participants.data.buyer, participants.data.seller, tradeInfo, unfilled);
            const channelRes = await channel.ready;
            if (channelRes.error || !channelRes.data) return channelRes;

            const historyTrade: IHistoryTrade = {
                txid: channelRes.data.txid,
                time: Date.now(),
                ...tradeInfo,
            };
            this.saveToHistory(historyTrade);
            return channelRes;
        } catch (error) {
            return { error: error.message };
        }
    }

    private lockOrder(order: TOrder, lock: boolean = true) {
        order.lock = lock;
        socketService.io.emit(EmitEvents.UPDATE_ORDERS_REQUEST);
    }

    private saveToHistory(historyTrade: IHistoryTrade) {
        this._historyTrades = [historyTrade, ...this.historyTrades.slice(0, 1999)];
        saveLog(this.orderbookName, "TRADE", historyTrade);
        socketService.io.emit(EmitEvents.UPDATE_ORDERS_REQUEST);
    }

    updatePlacedOrdersForSocketId(socketid: string) {
        const socketObj = socketService.io.sockets.sockets.get(socketid);
        // The socket may already be gone (e.g. the counterparty disconnected
        // mid-swap) — nothing to update in that case.
        if (!socketObj) return;
        const openedOrders = orderbookManager.getOrdersBySocketId(socketid);
        const orderHistory = orderbookManager.getOrdersHistory();
        socketObj.emit(EmitEvents.PLACED_ORDERS, { openedOrders, orderHistory });
    }

    private checkMatch(order: TOrder): IResult<{ match: TOrder }> {
        try {
            const { props, action } = order;
            const { price } = props;
        
            const sortFunc = action === EOrderAction.BUY
                ? (a: TOrder, b: TOrder) => a.props.price - b.props.price
                : (a: TOrder, b: TOrder) => b.props.price - a.props.price;

 
            const filteredOrders = this.orders.filter(o => {
                const idChecks = o.type === EOrderType.SPOT && order.type === EOrderType.SPOT
                    ? o.props.id_desired === order.props.id_for_sale && o.props.id_for_sale === order.props.id_desired
                    : o.type === EOrderType.FUTURES && order.type === EOrderType.FUTURES
                        ? o.props.contract_id === order.props.contract_id
                        : false;
                const buySellCheck = order.action === EOrderAction.BUY
                    ? o.action === EOrderAction.SELL
                    : order.action === EOrderAction.SELL
                        ? o.action === EOrderAction.BUY
                        : false;
                const priceCheck = order.action === EOrderAction.BUY
                    ? o.props.price <= price
                    : order.action === EOrderAction.SELL
                        ? o.props.price >= price
                        : false;
                const lockCheck = !o.lock;
                // A resting order with no quantity left is never a match.
                const amountCheck = o.props.amount > 0;
                return idChecks && buySellCheck && priceCheck && lockCheck && amountCheck;
            }).sort(sortFunc);
            if (filteredOrders.length) {
                const matchOrder= filteredOrders[0];
                if (matchOrder.socket_id === order.socket_id) {
                    throw new Error("Match of the order from the same Account");
                }
                if (matchOrder.keypair.address === order.keypair.address) {
                    throw new Error("Match of the order from the same address");
                }
                return { data: { match: matchOrder } };
            }
            return { data: { match: null } };
        } catch(error) {
            return { error: error.message };
        }
    }

    async addOrder(order: TOrder, noTrades: boolean = false): Promise<IResult<{ order?: TOrder, trade?: ITradeInfo }>> {
        try {
            const propsError = validateOrderbookNameProps(order);
            if (propsError) {
                throw new Error(propsError);
            }

            if (!this.checkCompatible(order)) {
                throw new Error(`Order missmatch current orderbook interface or type`);
            }

            const matchRes = this.checkMatch(order);
            if (matchRes.error || !matchRes.data) throw new Error(`${matchRes.error || "Undefined Error"}`);
            if (!matchRes.data.match) {
                saveLog(this.orderbookName, "ORDER", order);
                orderbookManager.recordOrderHistory(order);
                this.orders = [...this.orders, order];
                this.updatePlacedOrdersForSocketId(order.socket_id);
                return { data: { order } };
            } else {

                // Without trades an order that crosses the book is refused explicitly,
                // so it is neither silently dropped nor rested as a crossed book entry.
                if (noTrades) return { error: 'Order crosses the book and was not placed: trades are disabled for this batch' };
                // The trade is built before the maker is locked. A refusal here must not leave the
                // maker locked: a locked order is hidden from matching and cannot be cancelled.
                const buildTradeRes = buildTrade(order, matchRes.data.match);
                if (buildTradeRes.error || !buildTradeRes.data) {
                    throw new Error(`${buildTradeRes.error || "Building Trade Failed. Code 2"}`);
                }
                this.lockOrder(matchRes.data.match);

                const newChannelRes = await this.newChannel(buildTradeRes.data.tradeInfo, buildTradeRes.data.unfilled);
                if (newChannelRes.error || !newChannelRes.data) {
                    if (newChannelRes.timedOut) {
                        // The swap timed out (silent counterparty): reverse the lock
                        // taken above so the maker order cannot stay locked forever.
                        this.lockOrder(matchRes.data.match, false);
                    } else {
                        // `newChannelRes.socketId` is the server-derived terminator
                        // (the socket that actually emitted TERMINATE_TRADE). Only
                        // the owner of the resting order may cancel it out of the
                        // book; anyone else terminating the trade just unlocks it.
                        if (newChannelRes.socketId && newChannelRes.socketId === matchRes.data.match.socket_id) {
                            // Removal goes through the manager so the CANCALED audit state is written.
                            // The order is still locked here, so this is the settlement-owned removal.
                            orderbookManager.removeOrder(matchRes.data.match.uuid, newChannelRes.socketId, true);
                        } else {
                            this.lockOrder(matchRes.data.match, false);
                        }
                    }
                    this.updatePlacedOrdersForSocketId(matchRes.data.match.socket_id);
                    throw new Error(`${newChannelRes.error || "Undefined Error"}`);
                }

                if (buildTradeRes.data.unfilled?.uuid === matchRes.data.match.uuid) {
                    matchRes.data.match.props.amount = buildTradeRes.data.unfilled.props.amount;
                    this.lockOrder(matchRes.data.match, false);
                } else {
                    // The matched order is fully filled. The FILLED marker is only
                    // written now that the swap has actually settled — never before,
                    // so an aborted/timed-out swap cannot mark a live order FILLED.
                    updateOrderLog(this.orderbookName, matchRes.data.match.uuid, 'FILLED');
                    orderbookManager.markOrderHistory(matchRes.data.match.uuid, 'FILLED');
                    this.removeOrder(matchRes.data.match.uuid, matchRes.data.match.socket_id, true);
                }
                this.updatePlacedOrdersForSocketId(matchRes.data.match.socket_id);

                if (buildTradeRes.data.unfilled?.uuid === order.uuid) {
                    // The taker's remainder re-enters through the manager, the single
                    // entry point. If the taker has disconnected meanwhile, the
                    // remainder is refused there and the completed trade still stands.
                    // A refused remainder is returned as the error it is, so the caller reports it.
                    return orderbookManager.addOrder(buildTradeRes.data.unfilled);
                }
                this.updatePlacedOrdersForSocketId(order.socket_id);

                return { data: { trade: newChannelRes.data }};
            }
        } catch (error) {
            return { error: error.message };
        }
    }

    findByFilter(filter: TFilter) {
        // A client filter is untrusted: anything that is not an object matches nothing.
        if (!filter || typeof filter !== 'object') return false;
        if (!this.props) return false;
        if (filter.type !== this.type) return false;
        if (filter.type === EOrderType.SPOT && 'id_desired' in this.props ) {

            const checkA = filter.first_token === this.props.id_desired 
                && filter.second_token === this.props.id_for_sale;

            const checkB = filter.first_token === this.props.id_for_sale 
                && filter.second_token  === this.props.id_desired;

            return checkA || checkB;
        }
        if (filter.type === EOrderType.FUTURES && 'contract_id' in this.props) {
            return filter.contract_id === this.props.contract_id;
        }

        return false;
    }

    checkCompatible(order: TOrder): boolean {
        if (!this.props) return false;
        if (order.type !== this.type) return false;
        if (order.type === EOrderType.SPOT && 'id_desired' in this.props) {

            const checkA = order.props.id_desired === this.props.id_desired 
                && order.props.id_for_sale === this.props.id_for_sale;

            const checkB = order.props.id_desired === this.props.id_for_sale 
                && order.props.id_for_sale === this.props.id_desired;

            return checkA || checkB;
        }

        if (order.type === EOrderType.FUTURES && 'contract_id' in this.props) {
            return order.props.contract_id === this.props.contract_id;
        }

        return false;
    }

    // The single removal decision. A client-initiated cancel (duringSettlement=false)
    // is refused for an order locked by an in-flight swap: the swap owns that order
    // until it settles or times out. Only the swap engine and the disconnect hook pass
    // duringSettlement=true.
    removeOrder(uuid: string, socket_id: string, duringSettlement: boolean = false): IResult {
        try {
            const orderForRemove = this.orders.find(o => o.uuid === uuid);

            // check if the order exist;
            if (!orderForRemove) {
                throw new Error(`Order with uuid ${uuid} dont exist in current orderbook`);
            }

            // check if the client with same uuid want to remove the order
            // this logic may be improved for better security
            if (socket_id !== orderForRemove.socket_id) {
                throw new Error(`Not Authorized to remove order with uuid: ${uuid}`);
            }

            if (orderForRemove.lock && !duringSettlement) {
                throw new Error(`Order with uuid ${uuid} is locked by a swap in progress`);
            }

            // remove the order
            this.orders = this.orders.filter(o => o !== orderForRemove);

            return { data: `Order with uuid ${uuid} was removed!` };
        } catch (error) {
            return { error: error.message };
        }
    }
}

// The values below end up in `orderbookName`, which is used to build log file
// names. They must be non-negative safe integers (or whitelisted string ids)
// at runtime — the type annotations alone do not protect against raw JSON input.
const validateOrderbookNameProps = (order: TOrder): string | null => {
    const { type } = order;
    if (type === EOrderType.SPOT) {
        const { id_for_sale, id_desired } = order.props;
        if (!isValidOrderIdProp(id_for_sale) || !isValidOrderIdProp(id_desired)) {
            return `Invalid order props: id_for_sale and id_desired must be non-negative safe integers or whitelisted ids`;
        }
        return null;
    }
    if (type === EOrderType.FUTURES) {
        const { contract_id } = order.props;
        if (!isNonNegativeSafeInteger(contract_id)) {
            return `Invalid order props: contract_id must be a non-negative safe integer`;
        }
        return null;
    }
    return `Invalid order type`;
};

const buildTrade = (new_order: TOrder, old_order: TOrder): IResult<{ unfilled: TOrder, tradeInfo: ITradeInfo }> => {
    try {
        const ordersArray = [ new_order, old_order ];
        const buyOrder = ordersArray.find(t => t.action === EOrderAction.BUY);
        const sellOrder = ordersArray.find(t => t.action === EOrderAction.SELL);

        if (!buyOrder || !sellOrder) throw new Error("Building Trade Failed. Code 1");

        // All quantity math is exact, in units of 1e-8. No value is rounded: a remainder
        // or a trade value that is not representable is refused, never adjusted.
        const newUnits = toUnits(new_order.props.amount);
        const oldUnits = toUnits(old_order.props.amount);
        const priceUnits = toUnits(old_order.props.price);
        if (newUnits === null || oldUnits === null || priceUnits === null || newUnits <= 0 || oldUnits <= 0 || priceUnits <= 0) {
            throw new Error("Order amount and price must be positive multiples of 1e-8");
        }
        const amountUnits = Math.min(newUnits, oldUnits);
        const remainderUnits = Math.abs(newUnits - oldUnits);

        const unfilled = (newUnits > oldUnits
            ? {...new_order, props: {...new_order.props, amount: remainderUnits / UNIT_SCALE}}
            : newUnits < oldUnits
                ? {...old_order, props: {...old_order.props, amount: remainderUnits / UNIT_SCALE}}
                : null) as TOrder;

        const price = old_order.props.price;
        const amount = amountUnits / UNIT_SCALE;

        // LTC value of the trade in satoshis: amount units * price units / 1e8, exact.
        // A trade whose value is not a whole number of satoshis is refused, not rounded.
        const isFutures = buyOrder.type === EOrderType.FUTURES;
        const valueSats = isFutures ? 0 : mulDivUnits(amountUnits, priceUnits);
        if (!isFutures && (valueSats === null || valueSats <= 0)) {
            throw new Error("Trade value is not a whole number of satoshis: the match is refused");
        }

        const tradeInfo: ITradeInfo = {
            type: new_order.type,
            buyer: {
                socketId: buyOrder.socket_id,
                keypair: {
                    address: buyOrder.keypair.address,
                    pubkey: buyOrder.keypair.pubkey,
                },
            },
            seller: {
                socketId: sellOrder.socket_id,
                keypair: {
                    address: sellOrder.keypair.address,
                    pubkey: sellOrder.keypair.pubkey,
                }
            },
            taker: new_order.socket_id,
            maker: old_order.socket_id,
            props: isFutures
                ? {
                    amount: amount,
                    contract_id: buyOrder.props.contract_id,
                    price: price,
                    levarage: buyOrder.props.levarage,
                    collateral: buyOrder.props.collateral,
                }
                : {
                    propIdDesired: buyOrder.props.id_desired,
                    propIdForSale:  buyOrder.props.id_for_sale,
                    amountDesired: amount,
                    amountForSale: (valueSats as number) / UNIT_SCALE,
                }
        };
        return { data: { unfilled, tradeInfo }}
    } catch (error) {
        return { error: error.message };
    }
}