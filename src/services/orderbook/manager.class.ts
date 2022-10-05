import { TOrder } from "../../utils/types/orderbook.types";
import { IResult } from "../../utils/types/mix.types";
import { Orderbook } from "./orderbook.class";

export class OrderbookManager {
    orderbooks: Orderbook[] = [];

    constructor () {
        console.log(`Orderbook Service Initialized`);
    }

    private newOrderbook(firstOrder: TOrder): IResult<{ order?: any, trade?: any }> {
        try {
            const orderbook = new Orderbook(firstOrder);
            this.orderbooks.push(orderbook);
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
            const res = orderbook.removeOrder(uuid, socket_id);
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
}
