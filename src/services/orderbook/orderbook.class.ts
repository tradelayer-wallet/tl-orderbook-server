// orderbook.class.ts
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
import { socketManager } from "../socket"; // Updated import
import { ChannelSwap } from "../channel-swap/channel-swap.class";
import { TFilter } from "../../utils/types/markets.types";
import { orderbookManager } from ".";
import { EmitEvents } from "../socket/events";
import { readdirSync, readFileSync } from "fs";
import { Websocket } from 'hyper-express'; // Import Websocket type

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
        // Send updates to all connected WebSocket clients when order changes
        socketManager.broadcastToAll({
           event: EmitEvents.ORDERBOOK_DATA,
           orders: this._orders,
           history: this._historyTrades,
        });
    }

    get orderbookName() {
        if (this.type === EOrderType.SPOT && 'id_desired' in this.props) {
            const spotProps = this.props as ISpotOrderProps;
            return `spot_${spotProps.id_for_sale}_${spotProps.id_desired}`;
        } else if (this.type === EOrderType.FUTURES && 'contract_id' in this.props) {
            const futuresProps = this.props as IFuturesOrderProps;
            return `futures-${futuresProps.contract_id}`;
        } else {
            return null;
        }
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
            let names: string[] = [];

            if (this.type === EOrderType.SPOT && 'id_desired' in this.props && 'id_for_sale' in this.props) {
                const spotProps = this.props as ISpotOrderProps;
                names = [
                    `spot_${spotProps.id_for_sale}-${spotProps.id_desired}`,
                    `spot_${spotProps.id_desired}_${spotProps.id_for_sale}`,
                ];
            } else if (this.type === EOrderType.FUTURES && 'contract_id' in this.props) {
                const futuresProps = this.props as IFuturesOrderProps;
                names = [`futures-${futuresProps.contract_id}`];
            }

            const currentOBTradeFiles = existingFiles.filter(q => {
                if (!q.startsWith('TRADE')) return false;
                if (!names.length) return false;
                return names.some(w => q.includes(w));
            });

            currentOBTradeFiles.forEach(f => {
                const stringData = readFileSync(`logs/${f}`, 'utf8');
                const arrayData = stringData
                    .split('\n')
                    .filter(line => line.trim() !== '')
                    .map(q => JSON.parse(q) as IHistoryTrade);
                arrayData.forEach(d => data.push(d));
            });
            this._historyTrades = data.slice(0, 2000);
            // Notify all connected clients of updated orderbook history
            socketManager.broadcastToAll({
                event: EmitEvents.ORDERBOOK_DATA,
                orders: this._orders,
                history: this._historyTrades,
            });

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
                const { id_desired, id_for_sale } = order.props as ISpotOrderProps;
                this.props = { id_desired, id_for_sale } as ISpotOrderProps;
            }

            if (type === EOrderType.FUTURES) {
                const { contract_id } = order.props as IFuturesOrderProps;
                this.props = { contract_id } as IFuturesOrderProps;
            }

            return { data: null };
        } catch (error) {
            return { error: error.message };
        }
    }

    private async newChannel(tradeInfo: ITradeInfo, unfilled: TOrder): Promise<IResultChannelSwap> {
        try {
            const buyerSocketId = tradeInfo.buyer.socketId;
            const sellerSocketId = tradeInfo.seller.socketId;
            const buyerSocket = socketManager.getSocketById(buyerSocketId) as Websocket;
            const sellerSocket = socketManager.getSocketById(sellerSocketId) as Websocket;

            if (!buyerSocket || !sellerSocket) {
                throw new Error("One of the sockets is not available");
            }

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
        this._orders.forEach(order => {
            const socket = socketManager.getSocketById(order.socket_id) as Websocket;
            if (socket) {
                socket.send(JSON.stringify({ event: EmitEvents.UPDATE_ORDERS_REQUEST }));
            }
        });
    }

    private saveToHistory(historyTrade: IHistoryTrade) {
        this._historyTrades = [historyTrade, ...this.historyTrades.slice(0, 1999)];
        saveLog(this.orderbookName, "TRADE", historyTrade);
        this._orders.forEach(order => {
            const socket = socketManager.getSocketById(order.socket_id) as Websocket;
            if (socket) {
                socket.send(JSON.stringify({ event: EmitEvents.UPDATE_ORDERS_REQUEST }));
            }
        });
    }

    updatePlacedOrdersForSocketId(socketid: string) {
        const openedOrders = orderbookManager.getOrdersBySocketId(socketid);
        const orderHistory = orderbookManager.getOrdersHistory();
        const socketObj = socketManager.getSocketById(socketid) as Websocket;
        if (socketObj) {
            socketObj.send(JSON.stringify({ event: EmitEvents.PLACED_ORDERS, openedOrders, orderHistory }));
        }
    }

    private checkMatch(order: TOrder): IResult<{ match: TOrder }> {
        try {
            const { props, action } = order;
            const { price } = props;

            const sortFunc = action === EOrderAction.BUY
                ? (a: TOrder, b: TOrder) => a.props.price - b.props.price
                : (a: TOrder, b: TOrder) => b.props.price - a.props.price;

            const filteredOrders = this.orders.filter(o => {
                const idChecks =
                    o.type === order.type &&
                    ((o.type === EOrderType.SPOT &&
                        (o.props as ISpotOrderProps).id_desired === (order.props as ISpotOrderProps).id_for_sale &&
                        (o.props as ISpotOrderProps).id_for_sale === (order.props as ISpotOrderProps).id_desired) ||
                        (o.type === EOrderType.FUTURES &&
                            (o.props as IFuturesOrderProps).contract_id === (order.props as IFuturesOrderProps).contract_id));

                const buySellCheck =
                    (order.action === EOrderAction.BUY && o.action === EOrderAction.SELL) ||
                    (order.action === EOrderAction.SELL && o.action === EOrderAction.BUY);

                const priceCheck =
                    (order.action === EOrderAction.BUY && o.props.price <= price) ||
                    (order.action === EOrderAction.SELL && o.props.price >= price);

                const lockCheck = !o.lock;
                return idChecks && buySellCheck && priceCheck && lockCheck;
            }).sort(sortFunc);

            if (filteredOrders.length) {
                const matchOrder = filteredOrders[0];
                if (matchOrder.socket_id === order.socket_id) {
                    throw new Error("Match of the order from the same Account");
                }
                if (matchOrder.keypair.address === order.keypair.address) {
                    throw new Error("Match of the order from the same address");
                }
                return { data: { match: matchOrder } };
            }
            return { data: { match: null } };
        } catch (error) {
            return { error: error.message };
        }
    }

    async addOrder(order: TOrder, noTrades: boolean = false): Promise<IResult<{ order?: TOrder; trade?: ITradeInfo }>> {
        try {
            if (!this.checkCompatible(order)) {
                throw new Error(`Order mismatch with current orderbook interface or type`);
            }

            const matchRes = this.checkMatch(order);
            if (matchRes.error || !matchRes.data) throw new Error(`${matchRes.error || "Undefined Error"}`);

            if (!matchRes.data.match) {
                saveLog(this.orderbookName, "ORDER", order);
                this.orders = [...this.orders, order];
                this.updatePlacedOrdersForSocketId(order.socket_id);
                return { data: { order } };
            } else {
                if (noTrades) return { data: {} };
                this.lockOrder(matchRes.data.match);
                updateOrderLog(this.orderbookName, matchRes.data.match.uuid, 'FILLED');
                const buildTradeRes = buildTrade(order, matchRes.data.match);
                if (buildTradeRes.error || !buildTradeRes.data) {
                    throw new Error(`${buildTradeRes.error || "Building Trade Failed. Code 2"}`);
                }

                const newChannelRes = await this.newChannel(buildTradeRes.data.tradeInfo, buildTradeRes.data.unfilled);
                if (newChannelRes.error || !newChannelRes.data) {
                    if (matchRes.data.match.socket_id !== newChannelRes.socketId) {
                        this.lockOrder(matchRes.data.match, false);
                    } else {
                        this.removeOrder(matchRes.data.match.uuid, matchRes.data.match.socket_id);
                    }
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

                return { data: { trade: newChannelRes.data } };
            }
        } catch (error) {
            return { error: error.message };
        }
    }

    findByFilter(filter: TFilter) {
        if (!this.props) return false;
        if (filter.type !== this.type) return false;

        if (filter.type === EOrderType.SPOT && 'id_desired' in this.props) {
            const spotProps = this.props as ISpotOrderProps;
            const checkA = filter.first_token === spotProps.id_desired && filter.second_token === spotProps.id_for_sale;
            const checkB = filter.first_token === spotProps.id_for_sale && filter.second_token === spotProps.id_desired;
            return checkA || checkB;
        }

        if (filter.type === EOrderType.FUTURES && 'contract_id' in this.props) {
            const futuresProps = this.props as IFuturesOrderProps;
            return filter.contract_id === futuresProps.contract_id;
        }

        return false;
    }

    checkCompatible(order: TOrder): boolean {
        if (!this.props) return false;
        if (order.type !== this.type) return false;

        if (order.type === EOrderType.SPOT && 'id_desired' in this.props) {
            const spotProps = this.props as ISpotOrderProps;
            const orderProps = order.props as ISpotOrderProps;
            const checkA = orderProps.id_desired === spotProps.id_desired && orderProps.id_for_sale === spotProps.id_for_sale;
            const checkB = orderProps.id_desired === spotProps.id_for_sale && orderProps.id_for_sale === spotProps.id_desired;
            return checkA || checkB;
        }

        if (order.type === EOrderType.FUTURES && 'contract_id' in this.props) {
            const futuresProps = this.props as IFuturesOrderProps;
            const orderProps = order.props as IFuturesOrderProps;
            return orderProps.contract_id === futuresProps.contract_id;
        }

        return false;
    }

    removeOrder(uuid: string, socket_id: string): IResult {
        try {
            const orderForRemove = this.orders.find(o => o.uuid === uuid);

            // Check if the order exists
            if (!orderForRemove) {
                throw new Error(`Order with uuid ${uuid} doesn't exist in current orderbook`);
            }

            // Check if the client with same uuid wants to remove the order
            if (socket_id !== orderForRemove.socket_id) {
                throw new Error(`Not Authorized to remove order with uuid: ${uuid}`);
            }

            // Remove the order
            this.orders = this.orders.filter(o => o !== orderForRemove);

            return { data: `Order with uuid ${uuid} was removed!` };
        } catch (error) {
            return { error: error.message };
        }
    }
}

// Helper function for building trades
const buildTrade = (
    new_order: TOrder,
    old_order: TOrder
): IResult<{ unfilled: TOrder; tradeInfo: ITradeInfo }> => {
    try {
        const ordersArray = [new_order, old_order];
        const buyOrder = ordersArray.find(t => t.action === EOrderAction.BUY);
        const sellOrder = ordersArray.find(t => t.action === EOrderAction.SELL);

        if (!buyOrder || !sellOrder) throw new Error("Building Trade Failed. Code 1");
        const newOrderAmount = new_order.props.amount;
        const oldOrderAmount = old_order.props.amount;

        const unfilled = (newOrderAmount > oldOrderAmount
            ? { ...new_order, props: { ...new_order.props, amount: safeNumber(newOrderAmount - oldOrderAmount) } }
            : newOrderAmount < oldOrderAmount
                ? { ...old_order, props: { ...old_order.props, amount: safeNumber(oldOrderAmount - newOrderAmount) } }
                : null) as TOrder;

        const amount = Math.min(newOrderAmount, oldOrderAmount);
        const price = old_order.props.price;

        let tradeProps: any;
        if (buyOrder.type === EOrderType.FUTURES) {
            const buyOrderProps = buyOrder.props as IFuturesOrderProps;
            tradeProps = {
                amount: amount,
                contract_id: buyOrderProps.contract_id,
                price: price,
                levarage: buyOrderProps.levarage,
                collateral: buyOrderProps.collateral,
            };
        } else {
            const buyOrderProps = buyOrder.props as ISpotOrderProps;
            tradeProps = {
                propIdDesired: buyOrderProps.id_desired,
                propIdForSale: buyOrderProps.id_for_sale,
                amountDesired: amount,
                amountForSale: safeNumber(amount * price),
            };
        }

        const tradeInfo: ITradeInfo = {
            type: new_order.type,
            buyer: {
                socketId: buyOrder.socket_id,
                keypair: buyOrder.keypair,
            },
            seller: {
                socketId: sellOrder.socket_id,
                keypair: sellOrder.keypair,
            },
            taker: new_order.socket_id,
            maker: old_order.socket_id,
            props: tradeProps,
        };

        return { data: { unfilled, tradeInfo } };
    } catch (error) {
        return { error: error.message };
    }
};
