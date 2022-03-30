import { TOrder } from "../../utils/types/orderbook.types";
import { IResult } from "../../utils/types/mix.types";
import { Orderbook } from "./orderbook.class";

export class OrderbookManager {
    orderbooks: Orderbook[] = [];

    constructor () {
        console.log(`Orderbook Service Initialized`);
    }

    private newOrderbook(firstOrder: TOrder): IResult {
        try {
            const orderbook = new Orderbook(firstOrder);
            this.orderbooks.push(orderbook);
            return { data: orderbook.orders[0] };
        } catch (error) {
            return { error: error.message };
        }
    }

    addOrder(order: TOrder): IResult {
            try {
                const existingOrderbook = this.orderbooks.find(b => b.checkCompatible(order));
                const res = existingOrderbook
                    ? existingOrderbook.addOrder(order)
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
            const res = orderbook.removeOrder(uuid, socket_id);
            return res;
        } catch (error) {
            return { error: error.message };
        }
    }
}