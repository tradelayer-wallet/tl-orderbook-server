import { EOrderType, TOrder } from "../../utils/types/orderbook.types";
import { IResult } from "../../utils/types/mix.types";

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
        this.addOrder(firstOrder)
    }

    get type(): EOrderType {
        return this._type;
    }

    get orders(): TOrder[] {
        return this._orders;
    }

    set orders(value: TOrder[]) {
        this._orders = value;
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

    addOrder(order: TOrder): IResult {
        try {
            if (!this.checkCompatible(order)) {
                throw new Error(`Order missmatch current orderbook interface or type`);
            }
            // more checks;
            this.orders = [...this.orders, order];
            return { data: order };
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
}
