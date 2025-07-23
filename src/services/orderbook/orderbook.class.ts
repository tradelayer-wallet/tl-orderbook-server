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

type Agg = {
  maker: TOrder;          // live reference
  takerSlices: TOrder[];  // individual slices we matched
  totalAmt: number;       // Σ slice.amount
  weighted: number;       // Σ slice.amount * maker.price
};

/* ------------------------------------------------------------------
 *  Small helper so we don’t litter code with console.log everywhere.
 * ------------------------------------------------------------------ */
const DBG = (...args: any[]) => {
  const ts = new Date().toISOString().slice(11, 23);      // HH:MM:SS.mmm
  console.log(`\x1b[36m[OB DEBUG ${ts}]\x1b[0m`, ...args); // cyan
};


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

    /* Fire-and-forget helper so we don’t have to sprinkle loops everywhere */
        private pushPlaced = (...socketIds: string[]) => {
            socketIds.forEach(sid => this.updatePlacedOrdersForSocketId(sid));
        };


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

  
/** True when two *orders* belong to the same contract / spot pair. */
private sameMarket(a: TOrder, b: TOrder): boolean {
  if (a.type !== b.type) return false;

  if (a.type === EOrderType.FUTURES) {
    const ca = (a.props as IFuturesOrderProps).contract_id;
    const cb = (b.props as IFuturesOrderProps).contract_id;
    return ca === cb;
  }

  // SPOT – treat the unordered pair as one market
  const pa = a.props as ISpotOrderProps;
  const pb = b.props as ISpotOrderProps;
  const direct   = pa.id_desired === pb.id_desired && pa.id_for_sale === pb.id_for_sale;
  const inverted = pa.id_desired === pb.id_for_sale  && pa.id_for_sale  === pb.id_desired;
  return direct || inverted;
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

    private checkMatch(order: TOrder): IResult<{ match: TOrder | null }> {
  try {
    const isBuy = order.action === EOrderAction.BUY;
    const price  = order.props.price;

    const compatible = this.orders.filter(o => {
      if (o.lock) return false;
      if (o.action === order.action) return false;
      if (!this.sameMarket(o, order)) return false;
      if (isBuy ? o.props.price > price : o.props.price < price) return false;
      return true;
    });

    compatible.sort((a,b) => {
      if (isBuy) {
        if (a.props.price !== b.props.price) return a.props.price - b.props.price; // best ask
      } else {
        if (a.props.price !== b.props.price) return b.props.price - a.props.price; // best bid
      }
      return a.timestamp - b.timestamp; // time priority if present
    });

    const best = compatible[0];
    if (!best) return { data: { match: null } };

    if (best.socket_id === order.socket_id)
      throw new Error('Self-trade (socket)');
    if (best.keypair.address === order.keypair.address)
      throw new Error('Self-trade (address)');

    return { data: { match: best } };
  } catch (err) {
    return { error: (err as Error).message };
  }
}


    private cloneWithAmount(order: TOrder, amount: number): TOrder {
        // Type-guard for SPOT
        if (order.type === EOrderType.SPOT) {
            const props = order.props as ISpotOrderProps;
            return {
                ...order,
                props: {
                    ...props,
                    amount, // Set only amount, keep all others
                }
            };
        } else if (order.type === EOrderType.FUTURES) {
            const props = order.props as IFuturesOrderProps;
            return {
                ...order,
                props: {
                    ...props,
                    amount,
                }
            };
        }
        throw new Error('Unsupported order type in cloneWithAmount');
    }

      
    async addOrder(
      order: TOrder,
      noTrades = false
    ): Promise<IResult<{ order?: TOrder; trades?: ITradeInfo[] }>> {
      try {
        if (!this.checkCompatible(order))
          throw new Error('Order mismatch with order-book');

    /* -State we accumulate *during* the sweep - */
    let remaining        = order.props.amount;
    const touchedSockets = new Set<string>();     // every socket we must refresh
    const bucketByUuid   = new Map<string, Agg>(); // one bucket per maker UUID
      DBG(`New taker ${order.uuid.slice(0, 6)}…  ${order.action} ${order.props.amount} @ ${order.props.price}`);


    const pointTrades: ITradeInfo[] = [];         // if you still want per-slice

    /* - Matching loop - */
    const maxIters = this.orders.length + 1;
    for (let iter = 0; remaining > 0 && iter < maxIters; iter++) {

      // 1️⃣  search best maker for *current* residual
      const { data, error } =
        this.checkMatch(this.cloneWithAmount(order, remaining));
      if (error) throw new Error(error);
      const match = data.match;
      if (!match) break;                          // book exhausted

      // 2️⃣  self-trade guard
      if (
        match.socket_id === order.socket_id ||
        match.keypair.address === order.keypair.address
      ) {
        this.lockOrder(match); this.lockOrder(match, false);
        continue;
      }

      const fillAmt = Math.min(remaining, match.props.amount);

      /* - ✨  Aggregation bucket (by maker UUID) */
      let bucket = bucketByUuid.get(match.uuid);
      if (!bucket) {
        bucket = { maker: match, takerSlices: [], totalAmt: 0, weighted: 0 };
        bucketByUuid.set(match.uuid, bucket);
      }
      const takerSlice = this.cloneWithAmount(order, fillAmt);
      bucket.takerSlices.push(takerSlice);
      bucket.totalAmt += fillAmt;
      bucket.weighted += fillAmt * match.props.price;

      // 3️⃣  Book-keeping on the live resting order
      this.lockOrder(match);                      // lock before we mutate
        DBG(`   ⋆ fill ${fillAmt} vs maker ${match.uuid.slice(0, 6)}…  (before: ${match.props.amount})`);
      touchedSockets.add(match.socket_id);

      if (fillAmt === match.props.amount) {
        this.removeOrder(match.uuid, match.socket_id);     // fully filled
        updateOrderLog(this.orderbookName, match.uuid, 'FILLED');
           DBG(`     → maker exhausted and removed`);
             this.pushPlaced(match.socket_id);  
      } else {
        match.props.amount = safeNumber(match.props.amount - fillAmt);
        this.lockOrder(match, false);                      // unlock + broadcast
        updateOrderLog(this.orderbookName, match.uuid, 'PT-FILLED');
          DBG(`     → maker now ${match.props.amount} left`);
            this.pushPlaced(match.socket_id);  
      }

      /*  Optional: per-slice channel (legacy behaviour)  */
      if (!noTrades) {
        const makerSlice = this.cloneWithAmount(match, fillAmt);
        const sliceRes   = buildTrade(takerSlice, makerSlice);
        if (sliceRes.data) pointTrades.push(sliceRes.data.tradeInfo);
      }

      remaining = safeNumber(remaining - fillAmt);
      DBG('remaining reduced by fill amt '+remaining +' '+fillAmt)
    } // end matching loop

    /* - One channel per maker bucket (VWAP price)- */
    const aggTrades: ITradeInfo[] = [];

    if (!noTrades) {
      for (const bucket of bucketByUuid.values()) {
        const { maker, totalAmt, weighted } = bucket;

        // Build *one* synthetic taker order with VWAP price
        const takerCombined = { ...order };
        takerCombined.props = { ...order.props, amount: totalAmt };

        const vwap      = safeNumber(weighted / totalAmt);
        takerCombined.props.price = vwap;

        // Clone maker so amounts line up
        const makerCombined = this.cloneWithAmount(maker, totalAmt);

        const combRes = buildTrade(takerCombined, makerCombined);
        if (combRes.error){ 
        DBG(`! buildTrade failed`, combRes.error); 
        continue;}                      // (edge-case recovery)
        console.log('built trade about to make channel '+JSON.stringify(combRes.data.tradeInfo))
        const chanRes = this.newChannel(
          combRes.data.tradeInfo,
          combRes.data.unfilled
        );
        aggTrades.push(combRes.data.tradeInfo);
            DBG(`   ↳ opened channel VWAP ${vwap} for ${bucket.totalAmt}`);
      }
    }
       
    let residualOrder: TOrder | undefined = undefined;
    DBG('remaining '+remaining)
    if (remaining > 0) {
      // Always create new order object for remnant
      residualOrder = this.cloneWithAmount(order, remaining);
      const DUST_LIMIT = (order.type === "FUTURES") ? 1 : 1e-8;
      if (remaining >= DUST_LIMIT) {
        // Only recurse if:
        // - UUID is same (we're still working on this order)
        // - amount is reduced (progress made)
        console.log('replacing trade? '+Boolean(residualOrder.uuid === order.uuid)+' '+residualOrder.props.amount+' '+ order.props.amount+' '+JSON.stringify(residualOrder))
        if (residualOrder.uuid === order.uuid && residualOrder.props.amount < order.props.amount) {
           await this.addOrder(residualOrder, noTrades); // recursion: one step down
        }else{
            
            // Otherwise, just add the order to the book (or skip if dust)
            this.orders = [...this.orders, residualOrder];
        }
        saveLog(this.orderbookName, 'ORDER', residualOrder);
        DBG(`Residual taker ${remaining} added back to book`);
      }
    }

    /* Emit placed-orders refresh to everyone touched */
    touchedSockets.add(order.socket_id);
    for (const sid of touchedSockets)
      this.updatePlacedOrdersForSocketId(sid);1
      
    return {
      data: {
        trades : aggTrades.length ? aggTrades : undefined,   // aggregated swaps
        order  : residualOrder
      }
    };

  } catch (e) {
    return { error: (e as Error).message };
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
        console.log('building trade '+JSON.stringify(buyOrder)+' seller '+JSON.stringify(sellOrder))
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
              const buyOrderProps = old_order.props as IFuturesOrderProps;
            tradeProps = {
                amount: amount,
                contract_id: buyOrderProps.contract_id,
                price: price,
                initMargin: buyOrderProps.initMargin,
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
                uuid: buyOrder.uuid
            },
            seller: {
                socketId: sellOrder.socket_id,
                keypair: sellOrder.keypair,
                uuid: sellOrder.uuid
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
