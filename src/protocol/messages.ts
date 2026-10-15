import { v4 as uuidv4 } from 'uuid';
import { EOrderAction, EOrderType, TOrder } from "../utils/types/orderbook.types";
import { IResult } from "../utils/types/mix.types";
import { TFilter } from "../utils/types/markets.types";
import { isNonNegativeSafeInteger, isValidOrderIdProp } from "../utils/pure/mix.pure";
import { isWireUnits } from "../utils/pure/units";

// Every message the server accepts or sends is checked by one function here (protocol-v2.md B.3).
// Each parser returns the cleaned value: only the declared fields survive, and downstream code
// uses the result without checking it again.

const fail = (error: string): IResult<never> => ({ error });
const ok = <T>(data: T): IResult<T> => ({ data });

const isObject = (value: unknown): value is Record<string, any> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
const isPositiveUnits = (value: unknown): boolean => isWireUnits(value) && value > 0;
const isHex = (value: unknown, maxChars: number): value is string =>
    typeof value === 'string' && value.length <= maxChars && /^([0-9a-f]{2})+$/.test(value);
const isTxid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isSessionId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// ---- orders (client to server, and the server's order records) -------------

export const parseNewOrder = (raw: unknown, socket_id: string): IResult<TOrder> => {
    if (!isObject(raw)) return fail('Order payload must be an object');
    const { type, action, isLimitOrder, marketName, keypair, props } = raw;
    if (type !== EOrderType.SPOT && type !== EOrderType.FUTURES) return fail('Invalid order type');
    if (action !== EOrderAction.BUY && action !== EOrderAction.SELL) return fail('Invalid order action');
    if (isLimitOrder !== true) return fail('Only limit orders are allowed');
    if (!isText(marketName, 256)) return fail('Invalid marketName');
    if (!isObject(keypair)) return fail('Invalid keypair');
    if (!isText(keypair.address, 256)) return fail('Invalid keypair.address');
    if (!isText(keypair.pubkey, 256)) return fail('Invalid keypair.pubkey');
    if (!isObject(props)) return fail('Invalid order props');
    if (!isPositiveUnits(props.amount)) return fail('Order amount must be a positive integer number of units');
    if (!isPositiveUnits(props.price)) return fail('Order price must be a positive integer number of sats per token');

    const timestamp = Date.now();
    const uuid = uuidv4();
    const lock = false;
    const keys = { keypair: { address: keypair.address, pubkey: keypair.pubkey } };
    const base = { action, isLimitOrder, marketName, ...keys, timestamp, uuid, socket_id, lock };

    if (type === EOrderType.SPOT) {
        if (!isValidOrderIdProp(props.id_for_sale)) return fail('Invalid id_for_sale');
        if (!isValidOrderIdProp(props.id_desired)) return fail('Invalid id_desired');
        return ok({
            ...base,
            type,
            props: {
                id_for_sale: props.id_for_sale,
                id_desired: props.id_desired,
                amount: props.amount,
                price: props.price,
            },
        } as TOrder);
    }
    if (!isNonNegativeSafeInteger(props.contract_id)) return fail('Invalid contract_id');
    if (!isWireUnits(props.levarage) || props.levarage < 1) return fail('Order levarage must be a positive integer');
    if (!isPositiveUnits(props.collateral)) return fail('Order collateral must be a positive integer number of units');
    return ok({
        ...base,
        type,
        props: {
            contract_id: props.contract_id,
            amount: props.amount,
            price: props.price,
            levarage: props.levarage,
            collateral: props.collateral,
        },
    } as TOrder);
};

// update-orderbook: the market a client asks about.
export const parseOrderFilter = (raw: unknown): IResult<TFilter> => {
    if (!isObject(raw)) return fail('Invalid orderbook filter: expected an object');
    if (raw.type === EOrderType.SPOT) {
        if (!isValidOrderIdProp(raw.first_token) || !isValidOrderIdProp(raw.second_token)) {
            return fail('Invalid orderbook filter: first_token and second_token are required');
        }
        return ok({ type: EOrderType.SPOT, first_token: raw.first_token, second_token: raw.second_token });
    }
    if (raw.type === EOrderType.FUTURES) {
        if (!isNonNegativeSafeInteger(raw.contract_id)) return fail('Invalid orderbook filter: contract_id is required');
        return ok({ type: EOrderType.FUTURES, contract_id: raw.contract_id });
    }
    return fail('Invalid orderbook filter: type must be SPOT or FUTURES');
};

// close-order: the uuid of one of the sender's orders.
export const parseCloseOrder = (raw: unknown): IResult<string> =>
    isText(raw, 64) ? ok(raw) : fail('Invalid order uuid');

// ---- swap channel ------------------------------------------------------------

// The client-to-server envelope. The sender's socket is never read from the payload.
export interface ISwapEnvelope {
    sessionId: string;
    eventName: string;
    data: unknown;
}

export const parseSwapEnvelope = (raw: unknown): IResult<ISwapEnvelope> => {
    if (!isObject(raw) || !isSessionId(raw.sessionId) || !isText(raw.eventName, 64)) {
        return fail('Invalid swap event: sessionId (64 lowercase hex) and eventName are required');
    }
    return ok({ sessionId: raw.sessionId, eventName: raw.eventName, data: raw.data });
};

const NO_DATA = null;
const SWAP_DATA_ERROR = 'data does not match its schema';

const parseNoData = (data: unknown): IResult<null> =>
    data === undefined || data === NO_DATA ? ok(NO_DATA) : fail(SWAP_DATA_ERROR);

// SELLER:STEP1: the seller's 2-of-2 channel.
const parseChannel = (data: unknown): IResult<{ address: string; redeemScript: string; scriptPubKey: string }> => {
    if (!isObject(data) || !isText(data.address, 128) || !isHex(data.redeemScript, 4096) || !isHex(data.scriptPubKey, 128)) {
        return fail(SWAP_DATA_ERROR);
    }
    return ok({ address: data.address, redeemScript: data.redeemScript, scriptPubKey: data.scriptPubKey });
};

// SELLER:STEP3: the seller's commit output. `sats` is the output value in satoshis.
const parseCommitUtxo = (data: unknown): IResult<{ txid: string; vout: number; sats: number; scriptPubKey: string; redeemScript: string }> => {
    if (!isObject(data) || !isTxid(data.txid) || !isWireUnits(data.vout) || data.vout > 0xffffffff) return fail(SWAP_DATA_ERROR);
    if (!isPositiveUnits(data.sats) || !isHex(data.scriptPubKey, 128) || !isHex(data.redeemScript, 4096)) return fail(SWAP_DATA_ERROR);
    return ok({ txid: data.txid, vout: data.vout, sats: data.sats, scriptPubKey: data.scriptPubKey, redeemScript: data.redeemScript });
};

// BUYER:STEP4 and SELLER:STEP5: a PSBT as hex.
const parsePsbt = (data: unknown): IResult<string> => (isHex(data, 500000) ? ok(data) : fail(SWAP_DATA_ERROR));

// BUYER:STEP6: the txid of the broadcast transaction, lowercase.
const parseTxidData = (data: unknown): IResult<string> => (isTxid(data) ? ok(data) : fail(SWAP_DATA_ERROR));

// The negotiation steps in order, then the final buyer step. The server accepts only the next
// step, from its sender, with data that parses. This is the whole swap state machine.
export interface ISwapStep {
    eventName: string;
    sender: 'BUYER' | 'SELLER';
    parse: (data: unknown) => IResult<unknown>;
}

export const SWAP_STEPS: ISwapStep[] = [
    { eventName: 'SELLER:STEP1', sender: 'SELLER', parse: parseChannel },
    { eventName: 'BUYER:STEP2', sender: 'BUYER', parse: parseNoData },
    { eventName: 'SELLER:STEP3', sender: 'SELLER', parse: parseCommitUtxo },
    { eventName: 'BUYER:STEP4', sender: 'BUYER', parse: parsePsbt },
    { eventName: 'SELLER:STEP5', sender: 'SELLER', parse: parsePsbt },
    { eventName: 'BUYER:STEP6', sender: 'BUYER', parse: parseTxidData },
];

// The step after which the buyer holds a signature it can broadcast.
export const SIGNED_STEP_INDEX = SWAP_STEPS.findIndex((step) => step.eventName === 'SELLER:STEP5');

export const TERMINATE_EVENT = 'TERMINATE_TRADE';
export const SERVER_STATE_EVENT = 'SERVER:STATE';

// TERMINATE_TRADE data: the reason, or null for the default.
export const parseTerminateReason = (data: unknown): IResult<string | null> => {
    if (data === undefined || data === NO_DATA) return ok(NO_DATA);
    return isText(data, 256) ? ok(data) : fail(SWAP_DATA_ERROR);
};
