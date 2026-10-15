import { EOrderAction, EOrderType, IFuturesOrderProps, ISpotOrderProps, TOrder, TRawOrder } from "../../utils/types/orderbook.types";
import { IResult } from "../../utils/types/mix.types";
import { isNonNegativeSafeInteger, isPositiveFiniteNumber, isValidOrderIdProp, toUnits } from "../../utils/pure/mix.pure";
import { v4 as uuidv4 } from 'uuid';

const isNonEmptyString = (value: any): boolean =>
    typeof value === 'string' && value.length > 0 && value.length <= 256;

// The fields that name the market an order trades in. They become part of the orderbook name and so
// of its log file names: each must be a non-negative safe integer, or a whitelisted synthetic id.
// Checked at intake and again by the orderbook, the only place a book is created.
export const marketKeyError = (type: EOrderType, props: any): string | null => {
    if (type === EOrderType.SPOT) {
        if (!isValidOrderIdProp(props.id_for_sale)) return 'Invalid id_for_sale';
        if (!isValidOrderIdProp(props.id_desired)) return 'Invalid id_desired';
        return null;
    }
    if (type === EOrderType.FUTURES) return isNonNegativeSafeInteger(props.contract_id) ? null : 'Invalid contract_id';
    return 'Invalid order type';
};

const validateRawOrder = (rawOrder: TRawOrder): string | null => {
    if (!rawOrder || typeof rawOrder !== 'object') return 'Order payload must be an object';

    const { type, action, isLimitOrder, marketName, keypair, props } = rawOrder as any;

    if (type !== EOrderType.SPOT && type !== EOrderType.FUTURES) return 'Invalid order type';
    if (action !== EOrderAction.BUY && action !== EOrderAction.SELL) return 'Invalid order action';
    if (isLimitOrder !== true) return 'Only limit orders are allowed';
    if (!isNonEmptyString(marketName)) return 'Invalid marketName';

    if (!keypair || typeof keypair !== 'object') return 'Invalid keypair';
    if (!isNonEmptyString(keypair.address)) return 'Invalid keypair.address';
    if (!isNonEmptyString(keypair.pubkey)) return 'Invalid keypair.pubkey';

    if (!props || typeof props !== 'object') return 'Invalid order props';
    if (!isPositiveFiniteNumber(props.amount)) return 'Order amount must be a finite number > 0';
    if (!isPositiveFiniteNumber(props.price)) return 'Order price must be a finite number > 0';
    // Exact quantities only: at most 8 decimal places (the 1e-8 base unit), so no remainder or
    // trade value has to be rounded (see orderbook.class.ts buildTrade).
    if (toUnits(props.amount) === null) return 'Order amount must be a multiple of 1e-8 within the safe range';
    if (toUnits(props.price) === null) return 'Order price must be a multiple of 1e-8 within the safe range';

    const keyError = marketKeyError(type, props);
    if (keyError) return keyError;
    if (type === EOrderType.FUTURES) {
        if (!isPositiveFiniteNumber(props.levarage)) return 'Order levarage must be a finite number > 0';
        if (!isPositiveFiniteNumber(props.collateral)) return 'Order collateral must be a finite number > 0';
    }

    return null;
};

export const orderFactory = (rawOrder: TRawOrder, socket_id: string): IResult<TOrder> => {
    const validationError = validateRawOrder(rawOrder);
    if (validationError) return { error: validationError };

    const timestamp = Date.now();
    const uuid = uuidv4();
    const lock = false;
    const { type, action, isLimitOrder, marketName, keypair, props } = rawOrder as any;

    // The order is built from an explicit field list: no mass-assignment of raw JSON.
    const order = type === EOrderType.SPOT
        ? {
            type,
            action,
            isLimitOrder,
            marketName,
            keypair: { address: keypair.address, pubkey: keypair.pubkey },
            props: {
                id_for_sale: props.id_for_sale,
                id_desired: props.id_desired,
                amount: props.amount,
                price: props.price,
            } as ISpotOrderProps,
            timestamp,
            uuid,
            socket_id,
            lock,
        } as TOrder
        : {
            type,
            action,
            isLimitOrder,
            marketName,
            keypair: { address: keypair.address, pubkey: keypair.pubkey },
            props: {
                contract_id: props.contract_id,
                amount: props.amount,
                price: props.price,
                levarage: props.levarage,
                collateral: props.collateral,
            } as IFuturesOrderProps,
            timestamp,
            uuid,
            socket_id,
            lock,
        } as TOrder;

    return { data: order };
};
