export interface IResult<T = any> {
    data?: T;
    error?: string;
}

export interface IResultChannelSwap<T = any> {
    data?: T;
    error?: string;
    // Socket id of the party that terminated the trade. Always server-derived
    // from the emitting socket — never the client-supplied SwapEvent.socketId,
    // which is spoofable and would let a counterparty delete the maker's order.
    socketId?: string;
    timedOut?: boolean;
}