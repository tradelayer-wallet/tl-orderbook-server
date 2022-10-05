export interface IResult<T = any> {
    data?: T;
    error?: string;
}

export interface IResultChannelSwap<T = any> {
    data?: T;
    error?: string;
    socketId?: string;
}