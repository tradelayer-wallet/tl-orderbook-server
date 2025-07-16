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

    // New helper: broadcast full snapshot filtered to unlocked orders
    private broadcastSnapshot() {
        socketManager.broadcastToAll({
            event: EmitEvents.ORDERBOOK_DATA,
            orders: this._orders.filter(o => !o.lock),
            history: this._historyTrades,
        });
    }

    set orders(value: TOrder[]) {
        this._orders = value;
        // Send updates to all connected WebSocket clients when order changes
        this.broadcastSnapshot();
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
            this.broadcastSnapshot();

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

    // Changed to call broadcastSnapshot for everyone, not just per socket
    private lockOrder(order: TOrder, lock: boolean = true) {
        order.lock = lock;
        this.broadcastSnapshot();
    }

    private saveToHistory(historyTrade: IHistoryTrade) {
        this._historyTrades = [historyTrade, ...this.historyTrades.slice(0, 1999)];
        saveLog(this.orderbookName, "TRADE", historyTrade);
        this.broadcastSnapshot();
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

    /** ------------------------------------------------------------------
 *  MULTI‑FILL aware addOrder
 *  – Matches the incoming order against *all* compatible resting
 *    orders, best‑price first, until the incoming amount is zero or
 *    the book is exhausted.
 *  – Builds/opens a ChannelSwap for every fill.
 *  – Any residual (un‑filled) size is re‑inserted into the book.
 *  – Returns { trades: ITradeInfo[] } and/or { order: TOrder }.
 *  ------------------------------------------------------------------ */
async addOrder(
  incoming: TOrder,
  noTrades = false
): Promise<IResult<{ trades?: ITradeInfo[]; order?: TOrder }>> {
  try {
    /* 0️⃣ sanity ------------------------------------------------------ */
    if (!this.checkCompatible(incoming))
      throw new Error(`Order mismatch with this orderbook`);

    /* 1️⃣ pick the book side we can hit ------------------------------ */
    const priceOK = (rest: TOrder) =>
      incoming.action === EOrderAction.BUY
        ? rest.props.price <= incoming.props.price // taker is buying – wants the lowest ask(s)
        : rest.props.price >= incoming.props.price; // taker is selling – wants the highest bid(s)

    const sideOK = (rest: TOrder) =>
      incoming.action === EOrderAction.BUY
        ? rest.action === EOrderAction.SELL
        : rest.action === EOrderAction.BUY;

    const idOK = (rest: TOrder) =>
      rest.type === incoming.type &&
      (rest.type === EOrderType.SPOT
        ? (rest.props as ISpotOrderProps).id_desired ===
            (incoming.props as ISpotOrderProps).id_for_sale &&
          (rest.props as ISpotOrderProps).id_for_sale ===
            (incoming.props as ISpotOrderProps).id_desired
        : // FUTURES
          (rest.props as IFuturesOrderProps).contract_id ===
          (incoming.props as IFuturesOrderProps).contract_id);

    const candidateRestingOrders = this.orders
      .filter(
        o => !o.lock && idOK(o) && sideOK(o) && priceOK(o) // compatible & price‑acceptable
      )
      .sort((a, b) =>
        incoming.action === EOrderAction.BUY
          ? a.props.price - b.props.price // buy → cheapest first
          : b.props.price - a.props.price // sell → highest first
      );

    /* 2️⃣ iterate & fill --------------------------------------------- */
    let remaining = incoming.props.amount;
    const trades: ITradeInfo[] = [];

    for (const rest of candidateRestingOrders) {
      if (remaining <= 0) break;

      /* 2a – self‑trade / same address guard */
      if (rest.socket_id === incoming.socket_id)
        throw new Error(`Match of the order from the same socket`);
      if (rest.keypair.address === incoming.keypair.address)
        throw new Error(`Match of the order from the same address`);

      const fillAmt = Math.min(remaining, rest.props.amount);

      /* Slice out the fill‑sized “views” of each order */
      const takerSlice: TOrder = {
        ...incoming,
        props: { ...incoming.props, amount: fillAmt },
      };
      const makerSlice: TOrder = {
        ...rest,
        props: { ...rest.props, amount: fillAmt },
      };

      /* Build trade‑info & open the swap‐channel */
      const tradeRes = buildTrade(takerSlice, makerSlice);
      if (tradeRes.error || !tradeRes.data)
        throw new Error(tradeRes.error ?? `buildTrade failed`);

      if (!noTrades) {
        const ch = await this.newChannel(
          tradeRes.data.tradeInfo,
          tradeRes.data.unfilled // always null for a precise slice
        );
        if (ch.error) throw new Error(ch.error);
        trades.push(ch.data); // save the successful swap
      }

      /* 2b – adjust / purge maker order on the book */
      if (rest.props.amount === fillAmt) {
        // fully consumed
        this.removeOrder(rest.uuid, rest.socket_id);
      } else {
        // partially consumed
        rest.props.amount = safeNumber(rest.props.amount - fillAmt);
      }

      remaining = safeNumber(remaining - fillAmt);
    }

    /* 3️⃣ residual size?  stick it back on the book ------------------ */
    let residualOrder: TOrder | undefined;
    if (remaining > 0) {
      residualOrder = {
        ...incoming,
        props: { ...incoming.props, amount: remaining },
      };
      saveLog(this.orderbookName, "ORDER", residualOrder);
      this.orders = [...this.orders, residualOrder];
      this.updatePlacedOrdersForSocketId(residualOrder.socket_id);
    }

    return { data: { trades: trades.length ? trades : undefined, order: residualOrder } };
  } catch (err) {
    return { error: (err as Error).message };
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
            this.broadcastSnapshot();   // <- broadcast after removal

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
