// packages/wallet-server/src/services/orderbook/orderbook.class.ts
// KEEP this filename/class so the rest of your app stays unchanged.
import * as native from "./native/matcher-core.node";

export type TOrder = {
  uuid: string;
  side: "BUY" | "SELL";
  price: number;
  amount: number;
  socket_id?: string;
};

export class Orderbook {
  constructor(private symbol: string) {
    native.create_book(symbol);
  }
  dispose() { native.drop_book(this.symbol); }

  addOrder(o: TOrder) {
    // returns { fills: [...] } — adapt once to your current consumer
    return native.submit(this.symbol, o);
  }
  addOrdersBatch(os: TOrder[]) {
    return native.submit_batch(this.symbol, os);
  }
  removeOrder(orderId: string) {
    return native.cancel(this.symbol, orderId);
  }
  cancelAllBySocket(socketId: string) {
    return native.cancel_all_by_socket(this.symbol, socketId);
  }
  snapshot(depth = 20) {
    return JSON.parse(native.snapshot(this.symbol, depth));
  }
  stats() {
    return JSON.parse(native.stats(this.symbol));
  }
}
