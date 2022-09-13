import { EOrderAction, EOrderType, TOrder } from "../../utils/types/orderbook.types";
import { IResult } from "../../utils/types/mix.types";
import { safeNumber } from "../../utils/pure/mix.pure";
import { socketService } from "../socket";
import { ChannelSwap } from "../channel-swap/channel-swap.class";
import { TFilter } from "../../utils/types/markets.types";
import { orderbookManager } from ".";
import { EmitEvents } from "../socket/events";

export interface ITrade {
    amountDesired: number;
    amountForSale: number;
    buyerAddress: string;
    buyerPubKey: string;
    buyerSocketId: string;
    sellerAddress: string;
    sellerPubKey: string;
    sellerSocketId: string;
    secondSocketId: string;
    propIdDesired?: number;
    propIdForSale?: number;
    contractId?: number;
}

export class Orderbook {
    private _type: EOrderType;
    private _orders: TOrder[] = [];
    private props: {
        contract_id?: number, // used only for Futures Orderbooks
        id_desired?: number,  // used only for Spot Orderbooks
        id_for_sale?: number, // used only for Spot Orderbooks
    } = null;

    constructor(firstOrder: TOrder) {
        this._type = firstOrder.type;
        this.addProps(firstOrder);
        this.addOrder(firstOrder);
    }

    get type(): EOrderType {
        return this._type;
    }

    get orders(): TOrder[] {
        return this._orders;
    }

    set orders(value: TOrder[]) {
        this._orders = value;
        socketService.io.emit(EmitEvents.UPDATE_ORDERS_REQUEST);
    }

    private addProps(order: TOrder): IResult {
        try {
            if (this.props) {
                throw new Error(`Props for this orderbook already exist`);
            }

            const { type } = order;
            if (type === EOrderType.SPOT) {
                const { id_desired, id_for_sale } = order.props;
                this.props = { id_desired, id_for_sale };
            }

            if (type === EOrderType.FUTURES) {
                const { contract_id } = order.props;
                this.props = { contract_id };
            }

        } catch (error) {
            return { error: error.message };
        }
    }

    findByFilter(filter: TFilter) {
        if (!this.props) return false;
        if (filter.type !== this.type) return false;
        if (filter.type === EOrderType.SPOT) {

            const checkA = filter.first_token === this.props.id_desired 
                && filter.second_token === this.props.id_for_sale;

            const checkB = filter.first_token === this.props.id_for_sale 
                && filter.second_token  === this.props.id_desired;

            return checkA || checkB;
        }
        if (filter.type === EOrderType.FUTURES) {
            return filter.contractId === this.props.contract_id;
        }

        return false;
    }

    checkCompatible(order: TOrder): boolean {
        if (!this.props) return false;
        if (order.type !== this.type) return false;
        if (order.type === EOrderType.SPOT) {

            const checkA = order.props.id_desired === this.props.id_desired 
                && order.props.id_for_sale === this.props.id_for_sale;

            const checkB = order.props.id_desired === this.props.id_for_sale 
                && order.props.id_for_sale === this.props.id_desired;

            return checkA || checkB;
        }

        if (order.type === EOrderType.FUTURES) {
            return order.props.contract_id === this.props.contract_id;
        }

        return false;
    }

    async addOrder(order: TOrder): Promise<IResult<{ order?: TOrder, trade?: ITrade }>> {
        try {
            if (!this.checkCompatible(order)) {
                throw new Error(`Order missmatch current orderbook interface or type`);
            }

            const matchRes = this.checkMatch(order);
            if (matchRes.error || !matchRes.data) throw new Error(`${matchRes.error || "Undefined Error"}`);
            if (!matchRes.data.match) {
                this.orders = [...this.orders, order];
                return { data: { order } };
            } else {
                this.lockOrder(matchRes.data.match);
                const buildTradeRes = buildTrade(order, matchRes.data.match);
                if (buildTradeRes.error || !buildTradeRes.data) {
                    throw new Error(`${buildTradeRes.error || "Building Trade Failed. Code 2"}`);
                }

                const newChannelRes = await this.newChannel(buildTradeRes.data.trade, !buildTradeRes.data.unfilled);
                if (newChannelRes.error || !newChannelRes.data) {
                    throw new Error(`${newChannelRes.error || "Undefined Error"}`);
                }

                if (buildTradeRes.data.unfilled?.uuid === matchRes.data.match.uuid) {
                    matchRes.data.match.props.amount = buildTradeRes.data.unfilled.props.amount;
                    this.lockOrder(matchRes.data.match, false);
                } else {
                    this.removeOrder(matchRes.data.match.uuid, matchRes.data.match.socket_id);
                }

                if (buildTradeRes.data.unfilled?.uuid === order.uuid) {
                    const res = await this.addOrder(buildTradeRes.data.unfilled);
                    return { data: res.data };
                }
                return { data: { trade: newChannelRes.data }};
            }
        } catch (error) {
            return { error: error.message };
        }
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

    checkMatch(order: TOrder): IResult<{ match: TOrder }> {
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
            return { error: error.message };
        }
    }

    private async newChannel(trade: any, isFilled: boolean): Promise<IResult> {
        try {
            const { buyerSocketId, sellerSocketId } = trade;
            const buyerSocket = socketService.io.sockets.sockets.get(buyerSocketId);
            const sellerSocket = socketService.io.sockets.sockets.get(sellerSocketId);
            const channel = new ChannelSwap(buyerSocket, sellerSocket, trade, isFilled);
            const channelRes = await channel.onReady();
            if (channelRes.error || !channelRes.data) {
                throw new Error(channelRes.error || 'Undefined Channel swap error. Code 1');
            }

            // saveToHistory({ ...channel.trade, txid: res.data.txid });
            const buyerOrders = orderbookManager.getOrdersBySocketId(buyerSocket.id);
            const sellerOrders = orderbookManager.getOrdersBySocketId(sellerSocket.id);
            buyerSocket.emit(EmitEvents.PLACED_ORDERS, buyerOrders);
            sellerSocket.emit(EmitEvents.PLACED_ORDERS, sellerOrders);
            return channelRes;
        } catch (error) {
            return { error: error.message };
        }
    }

    private updateOrderAmount(order: TOrder, amount: number) {
        order.props.amount = amount;
    }

    private lockOrder(order: TOrder, lock: boolean = true) {
        order.lock = lock;
        socketService.io.emit(EmitEvents.UPDATE_ORDERS_REQUEST);
        // this.removeOrder(order.uuid, order.socket_id);
    }
}

const buildTrade = (new_order: TOrder, old_order: TOrder): IResult<{ unfilled: TOrder, trade: ITrade }> => {
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

        const trade: ITrade = {
            amountDesired: amount,
            amountForSale: safeNumber(amount * price),
            buyerAddress: buyOrder.keypair.address,
            buyerPubKey: buyOrder.keypair.pubkey, 
            buyerSocketId: buyOrder.socket_id,
            sellerAddress: sellOrder.keypair.address, 
            sellerPubKey: sellOrder.keypair.pubkey, 
            sellerSocketId: sellOrder.socket_id,
            secondSocketId: new_order.socket_id,
        };

        if (buyOrder.type === EOrderType.SPOT) {
            trade.propIdDesired = buyOrder.props.id_desired;
            trade.propIdForSale = buyOrder.props.id_for_sale;
        }

        if (buyOrder.type === EOrderType.FUTURES) {
            trade.contractId = buyOrder.props.contract_id;
        }

        return { data: { unfilled, trade }}
    } catch (error) {
        return { error: error.message };
    }
}