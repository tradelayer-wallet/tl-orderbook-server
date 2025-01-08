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
import { safeNumber, saveLog, updateOrderLog } from "../../utils/pure/mix.pure";
import { SocketManager } from "../socket/manager.class";
import { ChannelSwap } from "../channel-swap/channel-swap.class";
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
        SocketManager.io.emit(EmitEvents.UPDATE_ORDERS_REQUEST);
        
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
            SocketManager.io.emit(EmitEvents.UPDATE_ORDERS_REQUEST);
        } catch (error) {
            console.log({ error });
        }
    }

    private addProps(order: TOrder): IResult {
        try {
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

        } catch (error) {
            return { error: error.message };
        }
    }

    private async newChannel(tradeInfo: ITradeInfo, unfilled: TOrder): Promise<IResultChannelSwap> {
        try {
            const buyerSocketId = tradeInfo.buyer.socketId;
            const sellerSocketId = tradeInfo.seller.socketId;
            const buyerSocket = SocketManager.io.sockets.sockets.get(buyerSocketId);
            const sellerSocket = SocketManager.io.sockets.sockets.get(sellerSocketId);
            const channel = new ChannelSwap(buyerSocket, sellerSocket, tradeInfo, unfilled);
            const channelRes = await channel.onReady();
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
        SocketManager.io.emit(EmitEvents.UPDATE_ORDERS_REQUEST);
    }

    private saveToHistory(historyTrade: IHistoryTrade) {
        this._historyTrades = [historyTrade, ...this.historyTrades.slice(0, 1999)];
        saveLog(this.orderbookName, "TRADE", historyTrade);
        SocketManager.io.emit(EmitEvents.UPDATE_ORDERS_REQUEST);
    }

    updatePlacedOrdersForSocketId(socketid: string) {
        const openedOrders = orderbookManager.getOrdersBySocketId(socketid);
        const orderHistory = orderbookManager.getOrdersHistory();

            console.log('Current sockets:', Array.from(SocketManager.io.sockets.sockets.keys()));
        const socketObj = SocketManager.io.sockets.sockets.get(socketid);
        console.log('inside update place orders '+JSON.stringify(SocketManager.io.sockets.sockets))  
        if (!socketObj) {
            console.error(`Socket object not found for socket_id: ${socketid}`);
            return;
        }
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
                return idChecks && buySellCheck && priceCheck && lockCheck && lockCheck;
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
            console.log('error in match')
            return { error: error.message };
        }
    }

    async addOrder(order: TOrder, noTrades: boolean = false): Promise<IResult<{ order?: TOrder, trade?: ITradeInfo }>> {
        try {
            if (!this.checkCompatible(order)) {
                throw new Error(`Order missmatch current orderbook interface or type`);
            }

            const matchRes = this.checkMatch(order);
            console.log('match res '+JSON.stringify(matchRes))
            if (matchRes.error || !matchRes.data) throw new Error(`${matchRes.error || "Undefined Error"}`);
            if (!matchRes.data.match) {
                console.log('inside no match '+this.orderbookName+' '+JSON.stringify(order))
                saveLog(this.orderbookName, "ORDER", order);
                this.orders = [...this.orders, order];
                console.log('is orders not the err')
                this.updatePlacedOrdersForSocketId(order.socket_id);
                return { data: { order } };
            } else {

                if (noTrades) return;
                this.lockOrder(matchRes.data.match);
                updateOrderLog(this.orderbookName, matchRes.data.match.uuid, 'FILLED');
                const buildTradeRes = buildTrade(order, matchRes.data.match);
                if (buildTradeRes.error || !buildTradeRes.data) {
                    throw new Error(`${buildTradeRes.error || "Building Trade Failed. Code 2"}`);
                }

                const newChannelRes = await this.newChannel(buildTradeRes.data.tradeInfo, buildTradeRes.data.unfilled);
                console.log('new channel res '+JSON.stringify(newChannelRes)
                if (newChannelRes.error || !newChannelRes.data) {
                    console.log('new channel err '+JSON.stringify(newChannelRes.error))
                    matchRes.data.match.socket_id !== newChannelRes.socketId
                        ? this.lockOrder(matchRes.data.match, false)
                        : this.removeOrder(matchRes.data.match.uuid, matchRes.data.match.socket_id);
                    this.updatePlacedOrdersForSocketId(matchRes.data.match.socket_id);
                    throw new Error(`${newChannelRes.error || "Undefined Error"}`);
                }

                if (buildTradeRes.data.unfilled?.uuid === matchRes.data.match.uuid) {
                    matchRes.data.match.props.amount = buildTradeRes.data.unfilled.props.amount;
                    this.lockOrder(matchRes.data.match, false);
                } else {
                    this.removeOrder(matchRes.data.match.uuid, matchRes.data.match.socket_id);
                }
                this.updatePlacedOrdersForSocketId(matchRes.data.match.socket_id);

                if (buildTradeRes.data.unfilled?.uuid === order.uuid) {
                    const res = await this.addOrder(buildTradeRes.data.unfilled);
                    return { data: res.data };
                }
                this.updatePlacedOrdersForSocketId(order.socket_id);

                return { data: { trade: newChannelRes.data }};
            }
        } catch (error) {
            return { error: error.message };
        }
    }

    findByFilter(filter: TFilter) {
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

    removeOrder(uuid: string, socket_id: string): IResult {
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

            // remove the order
            this.orders = this.orders.filter(o => o !== orderForRemove);

            return { data: `Order with uuid ${uuid} was removed!` };
        } catch (error) {
            return { error: error.message };
        }
    }
}

const buildTrade = (new_order: TOrder, old_order: TOrder): IResult<{ unfilled: TOrder, tradeInfo: ITradeInfo }> => {
    try {
        const ordersArray = [ new_order, old_order ];
        const buyOrder = ordersArray.find(t => t.action === EOrderAction.BUY);
        const sellOrder = ordersArray.find(t => t.action === EOrderAction.SELL);

        if (!buyOrder || !sellOrder) throw new Error("Building Trade Failed. Code 1");
        const newOrderAmount = new_order.props.amount;
        const oldOrderAmount = old_order.props.amount

        const unfilled = (newOrderAmount > oldOrderAmount
            ? {...new_order, props: {...new_order.props, amount: safeNumber(newOrderAmount - oldOrderAmount)}}
            : newOrderAmount < oldOrderAmount
                ? {...old_order, props: {...old_order.props, amount: safeNumber(oldOrderAmount - newOrderAmount)}}
                : null) as TOrder;

        const amount = Math.min(newOrderAmount, oldOrderAmount);
        const price = old_order.props.price;

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
            props: buyOrder.type === EOrderType.FUTURES 
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
                    amountForSale: safeNumber(amount * price),
                }
        };
        return { data: { unfilled, tradeInfo }}
    } catch (error) {
        return { error: error.message };
    }
}
