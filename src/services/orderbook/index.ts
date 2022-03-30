import { OrderbookManager } from "./manager.class";

export const initOrderbookService = () => {
    orderbookManager = new OrderbookManager();
};

export let orderbookManager: OrderbookManager;