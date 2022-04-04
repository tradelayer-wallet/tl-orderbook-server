import { TOrder, TRawOrder } from "../../utils/types/orderbook.types";
import { v4 as uuidv4 } from 'uuid';

export const orderFactory = (rawOrder: TRawOrder, socket_id: string): TOrder => {
    const timestamp = Date.now();
    const uuid = uuidv4();
    const lock = false;
    const order = { ...rawOrder, timestamp, uuid, socket_id, lock };
    return order;
};
