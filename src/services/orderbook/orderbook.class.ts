import { 
    EOrderAction,
    EOrderType,
    IFuturesOrderProps,
    IHistoryTrade,
    ISpotOrderProps,
    ITradeInfo,
    TOrder,
} from "../../utils/types/orderbook.types";
import { IResult } from "../../utils/types/mix.types";
import { readNewestRecords, saveLog, updateOrderLog } from "../../utils/pure/mix.pure";
import { isWireUnits, valueSats } from "../../utils/pure/units";
import { socketService } from "../socket";
import { ChannelSwap, resolveSwapParticipants, TSwapOutcome } from "../channel-swap/channel-swap.class";
import { TFilter } from "../../utils/types/markets.types";
import { orderbookManager } from ".";
import { EmitEvents } from "../socket/events";

export class Orderbook {
    private _type: EOrderType;
    private _orders: TOrder[] = [];
    private _historyTrades: IHistoryTrade[] = [];
    private props: ISpotOrderProps | IFuturesOrderProps = null;

    constructor(firstOrder: TOrder) {
        this._type = firstOrder.type;
        this.addProps(firstOrder);
        this.rest(firstOrder);
        this.addExistingTradesHistory();
    }

    // Puts an order on the book: logged, recorded in the order history, and resting. The caller
    // has checked the resting limits and tells the owner about the change.
    private rest(order: TOrder): void {
        saveLog(this.orderbookName, "ORDER", order);
        orderbookManager.recordOrderHistory(order);
        this.orders = [...this.orders, order];
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

    // The names this market's logs are written under. A spot market is logged under the orientation
    // of the order that created its book, and a book created later may have the other orientation,
    // so both are read back.
    get logNames(): string[] {
        if (this.type === EOrderType.SPOT && 'id_desired' in this.props) {
            const { id_for_sale, id_desired } = this.props as ISpotOrderProps;
            return spotLogNames(id_for_sale, id_desired);
        }
        return [this.orderbookName];
    }

    private addExistingTradesHistory() {
        try {
            this._historyTrades = readTradeHistory(this.logNames);
            socketService.io.emit(EmitEvents.UPDATE_ORDERS_REQUEST);
        } catch (error) {
            console.log({ error });
        }
    }

    private addProps(order: TOrder): void {
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

    // Starts the swap for a matched trade and resolves with its terminal outcome. A counterparty
    // that is not connected is an abort before anything is locked or signed.
    private async runSwap(tradeInfo: ITradeInfo): Promise<TSwapOutcome> {
        const participants = resolveSwapParticipants(socketService.io, tradeInfo);
        if (participants.error || !participants.data) {
            return { state: 'aborted', reason: participants.error || 'Counterparty is not connected' };
        }
        return new ChannelSwap(participants.data.buyer, participants.data.seller, tradeInfo).outcome;
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
        socketObj.emit(EmitEvents.PLACED_ORDERS, orderbookManager.placedOrdersOf(socketid));
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
                // A crossing order whose trade cannot settle exactly is skipped when a settleable
                // one exists. Otherwise one such order at the best price would block every taker
                // at that price, at no cost to its owner. When none is settleable, the taker is
                // refused (below), so no order ever rests crossing the book.
                const settleable = filteredOrders.filter(o => settleMatch(order, o) !== null);
                if (!settleable.length) {
                    return { error: 'Trade value is not a whole number of satoshis: the match is refused' };
                }
                // The best settleable order of another account. The taker's own orders are skipped,
                // so it is refused only when every settleable crossing order is its own.
                const matchOrder = settleable.find(o => !isSameAccount(order, o));
                if (!matchOrder) {
                    throw new Error(settleable[0].socket_id === order.socket_id
                        ? "Match of the order from the same Account"
                        : "Match of the order from the same address");
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
            if (!this.checkCompatible(order)) {
                throw new Error(`Order missmatch current orderbook interface or type`);
            }

            const matchRes = this.checkMatch(order);
            if (matchRes.error || !matchRes.data) throw new Error(`${matchRes.error || "Undefined Error"}`);
            if (!matchRes.data.match) {
                const restingError = orderbookManager.restingCapError(order);
                if (restingError) throw new Error(restingError);
                this.rest(order);
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
                // A taker remainder will rest after the trade. If it could not rest, refuse before
                // the maker is locked or any swap starts, so no trade settles that the book cannot hold.
                if (buildTradeRes.data.unfilled?.uuid === order.uuid) {
                    const restingError = orderbookManager.restingCapError(order);
                    if (restingError) throw new Error(restingError);
                }
                const maker = matchRes.data.match;
                this.lockOrder(maker);
                const outcome = await this.runSwap(buildTradeRes.data.tradeInfo);
                if (outcome.state !== 'settled') {
                    // Only the owner of the resting order may take it out of the book by ending the
                    // trade. Any other outcome unlocks it. A swap that expired unverified leaves it
                    // unlocked too: the bounded residual risk in protocol-v2.md B.4.
                    const ownerEnded = outcome.state === 'aborted' && outcome.terminatorSocketId === maker.socket_id;
                    if (ownerEnded) {
                        // Removal goes through the manager so the CANCALED audit state is written.
                        orderbookManager.removeOrder(maker.uuid, maker.socket_id, true);
                    } else {
                        this.lockOrder(maker, false);
                    }
                    this.updatePlacedOrdersForSocketId(maker.socket_id);
                    throw new Error(outcome.state === 'aborted' ? outcome.reason : 'Swap expired without a verified outcome: no trade recorded');
                }
                this.saveToHistory({ txid: outcome.txid, time: Date.now(), ...buildTradeRes.data.tradeInfo });

                if (buildTradeRes.data.unfilled?.uuid === maker.uuid) {
                    maker.props.amount = buildTradeRes.data.unfilled.props.amount;
                    this.lockOrder(maker, false);
                } else {
                    // The matched order is fully filled. The FILLED marker is only
                    // written now that the swap has actually settled — never before,
                    // so an aborted/timed-out swap cannot mark a live order FILLED.
                    updateOrderLog(this.logNames, maker.uuid, 'FILLED');
                    orderbookManager.markOrderHistory(maker.uuid, 'FILLED');
                    this.removeOrder(maker.uuid, maker.socket_id, true);
                    orderbookManager.releaseEmptyOrderbooks();
                }
                this.updatePlacedOrdersForSocketId(maker.socket_id);

                if (buildTradeRes.data.unfilled?.uuid === order.uuid) {
                    // The taker's remainder re-enters through the manager, the single
                    // entry point. If the taker has disconnected meanwhile, the
                    // remainder is refused there and the completed trade still stands.
                    // A refused remainder is returned as the error it is, so the caller reports it.
                    return orderbookManager.addOrder(buildTradeRes.data.unfilled);
                }
                this.updatePlacedOrdersForSocketId(order.socket_id);

                return { data: { trade: buildTradeRes.data.tradeInfo } };
            }
        } catch (error) {
            return { error: error.message };
        }
    }

    findByFilter(filter: TFilter) {
        if (!this.props) return false;
        if (filter.type !== this.type) return false;
        if (filter.type === EOrderType.SPOT && 'id_desired' in this.props) {
            // The filter names the pair as (first, second), in either order.
            return samePair({ id_desired: filter.first_token, id_for_sale: filter.second_token }, this.props);
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
            return samePair(order.props, this.props);
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

// The names a spot market's logs are written under: the orientation of the order that created its book,
// and the other orientation, since a book created later may have it.
export const spotLogNames = (id_for_sale: number | string, id_desired: number | string): string[] =>
    [`spot_${id_for_sale}_${id_desired}`, `spot_${id_desired}_${id_for_sale}`];

// The log names of the market a parsed filter names.
export const filterLogNames = (filter: TFilter): string[] =>
    filter.type === EOrderType.SPOT
        ? spotLogNames(filter.first_token, filter.second_token)
        : [`futures-${filter.contract_id}`];

// An ORDER or TRADE record in the protocol v2 shape: its amounts and price are integer units. Records
// written before v2 hold floats. Every reader skips them, so they are never sent or restored, because
// one malformed record would make a client refuse the whole view (protocol-v2.md N5).
export const isV2Record = (record: any): boolean => {
    const p = record?.props;
    if (!p) return false;
    const quantities = 'amountDesired' in p ? [p.amountDesired, p.amountForSale, p.price] : [p.amount, p.price];
    return quantities.every(isWireUnits);
};

// Trades of a market from its logs, newest first, at most as many as a live book keeps.
export const readTradeHistory = (names: string[]): IHistoryTrade[] =>
    readNewestRecords<IHistoryTrade>('TRADE', names, 2000, isV2Record)
        .sort((a, b) => (b.time || 0) - (a.time || 0))
        .slice(0, 2000);

// The same account as the taker: the same socket, or the same address on another socket.
const isSameAccount = (taker: TOrder, maker: TOrder): boolean =>
    maker.socket_id === taker.socket_id || maker.keypair.address === taker.keypair.address;

// Two spot markets are the same when their id pairs match in either order.
const samePair = (
    a: Pick<ISpotOrderProps, 'id_desired' | 'id_for_sale'>,
    b: Pick<ISpotOrderProps, 'id_desired' | 'id_for_sale'>,
): boolean =>
    (a.id_desired === b.id_desired && a.id_for_sale === b.id_for_sale)
    || (a.id_desired === b.id_for_sale && a.id_for_sale === b.id_desired);

// The exact settlement of a match between a taker and the maker it meets: the matched quantity and,
// for spot, the LTC value in satoshis at the maker's price (futures carry no value). Null when the
// value is not a whole number of satoshis. Such a match is refused, never rounded.
const settleMatch = (taker: TOrder, maker: TOrder) => {
    const amountUnits = Math.min(taker.props.amount, maker.props.amount);
    const value = taker.type === EOrderType.FUTURES ? 0 : valueSats(amountUnits, maker.props.price);
    if (value === null) return null;
    return { takerUnits: taker.props.amount, makerUnits: maker.props.amount, amountUnits, valueSats: value };
};

const buildTrade = (new_order: TOrder, old_order: TOrder): IResult<{ unfilled: TOrder, tradeInfo: ITradeInfo }> => {
    try {
        const ordersArray = [ new_order, old_order ];
        const buyOrder = ordersArray.find(t => t.action === EOrderAction.BUY);
        const sellOrder = ordersArray.find(t => t.action === EOrderAction.SELL);

        if (!buyOrder || !sellOrder) throw new Error("Building Trade Failed. Code 1");

        const settlement = settleMatch(new_order, old_order);
        if (!settlement) {
            throw new Error("Trade value is not a whole number of satoshis: the match is refused");
        }
        const { takerUnits, makerUnits, amountUnits, valueSats } = settlement;
        const remainderUnits = Math.abs(takerUnits - makerUnits);

        const unfilled = (takerUnits > makerUnits
            ? {...new_order, props: {...new_order.props, amount: remainderUnits}}
            : takerUnits < makerUnits
                ? {...old_order, props: {...old_order.props, amount: remainderUnits}}
                : null) as TOrder;

        const price = old_order.props.price;
        const amount = amountUnits;
        const isFutures = buyOrder.type === EOrderType.FUTURES;

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
                    amountForSale: valueSats,
                    price,
                }
        };
        return { data: { unfilled, tradeInfo }}
    } catch (error) {
        return { error: error.message };
    }
}