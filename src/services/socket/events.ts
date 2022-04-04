export const OnEvents = {
    CONNECTION: 'connection',
    DISCONNECT: 'disconnect',
    NEW_ORDER: 'new-order',
    UPDATE_ORDERBOOK: 'update-orderbook',
    CLOSE_ORDER: 'close-order',
};

export const EmitEvents = {
    ORDERBOOK_DATA: 'orderbook-data',
    PLACED_ORDERS: 'placed-orders',
    UPDATE_ORDERS_REQUEST: 'update-orders-request',
};

export const OrderEmitEvents = {
    ERROR: 'order:error',
    SAVED: 'order:saved',
};