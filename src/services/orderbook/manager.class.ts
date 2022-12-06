import { TOrder } from "../../utils/types/orderbook.types";
import { IResult } from "../../utils/types/mix.types";
import { Orderbook } from "./orderbook.class";
import { saveLog, updateOrderLog } from "../../utils/pure/mix.pure";
import moment = require("moment");
import { readdirSync, readFileSync } from "fs";

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
                const existingOrderbook = this.orderbooks.find(b => b.checkCompatible(order));
                const res = existingOrderbook
                    ? await existingOrderbook.addOrder(order, noTrades)
                    : this.newOrderbook(order);
                return res; 
            } catch (error) {
                return { error: error.message };
            }
    }

    removeOrder(uuid: string, socket_id: string): IResult {
        try {
            const orderbook = this.orderbooks.find(b => b.orders.find(o => o.uuid === uuid));
            if (!orderbook) {
                throw new Error(`Order with uuid: ${uuid} dont exist`);
            }
            const order = orderbook.orders.find(q => q.uuid === uuid);
            if (!order) {
                throw new Error(`Order with uuid: ${uuid} dont exist`);
            }
            const res = orderbook.removeOrder(uuid, socket_id);
            updateOrderLog(orderbook.orderbookName,order.uuid, "CANCALED");
            return res;
        } catch (error) {
            return { error: error.message };
        }
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
