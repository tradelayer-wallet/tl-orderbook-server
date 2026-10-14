import { TOrder } from "../../utils/types/orderbook.types";
import { IResult } from "../../utils/types/mix.types";
import { Orderbook } from "./orderbook.class";
import { saveLog, updateOrderLog } from "../../utils/pure/mix.pure";
import moment = require("moment");
import { readdirSync, readFileSync } from "fs";
import { getConnectedSocket } from "../socket";
import { envConfig } from "../../config/env.config";

export class OrderbookManager {
    orderbooks: Orderbook[] = [];

    constructor () {
        console.log(`Orderbook Service Initialized`);
    }

    private newOrderbook(firstOrder: TOrder): IResult<{ order?: any, trade?: any }> {
        try {
            const orderbook = new Orderbook(firstOrder);
            this.orderbooks.push(orderbook);
            orderbook.updatePlacedOrdersForSocketId(firstOrder.socket_id);
            return { data: { order: orderbook.orders[0] } };
        } catch (error) {
            return { error: error.message };
        }
    }

    async addOrder(order: TOrder, noTrades: boolean = false): Promise<IResult<{ order?: TOrder, trade?: any }>> {
            try {
                // Every order that enters the book goes through this method: client
                // orders, and the taker remainder of a swap (see orderbook.class.ts).
                // An order whose owner is not connected is refused here, so no ghost
                // order can rest or be matched.
                if (!getConnectedSocket(order.socket_id)) {
                    return { error: 'Order owner is not connected' };
                }
                const existingOrderbook = this.orderbooks.find(b => b.checkCompatible(order));
                // Any client can name a pair, so new books are capped. Refused before
                // anything is created, so a refusal leaves no state behind.
                if (!existingOrderbook && this.orderbooks.length >= envConfig.MAX_ORDERBOOKS) {
                    return { error: `Too many orderbooks: the server holds at most ${envConfig.MAX_ORDERBOOKS}` };
                }
                const res = existingOrderbook
                    ? await existingOrderbook.addOrder(order, noTrades)
                    : this.newOrderbook(order);
                return res; 
            } catch (error) {
                return { error: error.message };
            }
    }

    // duringSettlement is false by default, so a caller that forgets it gets the
    // safe behaviour (a locked order cannot be cancelled). Only internal settlement
    // and disconnect paths pass true.
    removeOrder(uuid: string, socket_id: string, duringSettlement: boolean = false): IResult {
        try {
            const orderbook = this.orderbooks.find(b => b.orders.find(o => o.uuid === uuid));
            if (!orderbook) {
                throw new Error(`Order with uuid: ${uuid} dont exist`);
            }
            const order = orderbook.orders.find(q => q.uuid === uuid);
            if (!order) {
                throw new Error(`Order with uuid: ${uuid} dont exist`);
            }
            const res = orderbook.removeOrder(uuid, socket_id, duringSettlement);
            // The audit state follows the outcome of the removal. A rejected
            // removal (not the owner, order gone) must leave the log untouched.
            if (!res.error) {
                updateOrderLog(orderbook.orderbookName, order.uuid, "CANCALED");
            }
            return res;
        } catch (error) {
            return { error: error.message };
        }
    }

    // Removes every resting order owned by a socket. Called from the socket
    // disconnect hook, the only place a socket's book state is released. A locked
    // order is removed too: its owner is gone, and the settlement path tolerates a
    // missing order.
    removeOrdersOfSocket(socket_id: string): void {
        this.getOrdersBySocketId(socket_id).forEach(o => this.removeOrder(o.uuid, socket_id, true));
    }

    getOrdersBySocketId(id: string) {
        const orders = [];
        this.orderbooks.forEach(ob => {
            ob.orders.forEach(o => {
                if (o.socket_id === id) orders.push(o);
            });
        });
        return orders;
    }

    getOrdersHistory() {
        try {
            const _path = `logs/`;
            const today = moment()
                .format('DD-MM-YYYY');
            const yesterday = moment()
                .subtract(1, 'days')
                .format('DD-MM-YYYY');
            const files = readdirSync(_path)
                .filter(f => f.startsWith('ORDER'))
                .filter(f => f.includes(today) || f.includes(yesterday));
            const resArray = [];
            files.forEach(f => {
                const filePath = _path + f;
                readFileSync(filePath, 'utf8')
                    .split('\n')
                    .slice(0, -1)
                    .forEach(q => resArray.push(JSON.parse(q)));
            });
            return  resArray.slice(0, 500);
        } catch (error) {
            console.log(error);
            return [];
        }
    }
}
