export const OnEvents = {
    CONNECTION: 'connection',
    DISCONNECT: 'disconnect',
    NEW_ORDER: 'new-order',
    MANY_ORDERS: 'many-orders',
    UPDATE_ORDERBOOK: 'update-orderbook',
    CLOSE_ORDER: 'close-order',
    SWAP: 'swap',
};

export const EmitEvents = {
    ORDERBOOK_DATA: 'orderbook-data',
    PLACED_ORDERS: 'placed-orders',
    UPDATE_ORDERS_REQUEST: 'update-orders-request',
    NEW_CHANNEL: 'new-channel',
    SWAP: 'swap',
};

export const OrderEmitEvents = {
    ERROR: 'order:error',
    SAVED: 'order:saved',
};