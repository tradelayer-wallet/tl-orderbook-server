import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, sep } from "path";
import { IHistoryTrade, TOrder } from "../types/orderbook.types";
import * as moment from 'moment';

// Quantities and prices are exact multiples of 1e-8 (the TradeLayer and LTC base unit). They
// are held as integers of that unit ("units") so that the book never rounds a quantity.
// Rounding a remainder to 6 decimals (the former safeNumber) created or destroyed quantity.
export const UNIT_SCALE = 100000000;

// The units of a number that is exactly a positive multiple of 1e-8, or null (zero or less, more
// than 8 decimal places, not finite, or beyond the safe integer range).
export const toUnits = (value: unknown): number | null => {
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) return null;
    const units = Math.round(value * UNIT_SCALE);
    if (!Number.isSafeInteger(units)) return null;
    return units / UNIT_SCALE === value ? units : null;
};

// Decimal product of two non-negative integers given as digit strings (no BigInt: the build
// targets ES5 and has no BigInt lib). Returns the digit string without leading zeros.
const mulDigitStrings = (x: string, y: string): string => {
    const xs = x.split('').reverse().map(Number);
    const ys = y.split('').reverse().map(Number);
    const out: number[] = [];
    for (let k = 0; k < xs.length + ys.length; k++) out.push(0);
    for (let i = 0; i < xs.length; i++) {
        for (let j = 0; j < ys.length; j++) out[i + j] += xs[i] * ys[j];
    }
    for (let k = 0; k < out.length - 1; k++) {
        out[k + 1] += Math.floor(out[k] / 10);
        out[k] = out[k] % 10;
    }
    return out.reverse().join('').replace(/^0+(?=\d)/, '');
};

// a * b / UNIT_SCALE, exact. Returns null when the quotient is not a whole number or is not
// a safe integer. Used for the satoshi value of a trade: units(amount) * units(price) / 1e8.
export const mulDivUnits = (a: number, b: number): number | null => {
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0) return null;
    const product = mulDigitStrings(String(a), String(b));
    if (product === '0') return 0;
    if (product.length <= 8) return null;
    if (!/^0{8}$/.test(product.slice(-8))) return null;
    const quotient = Number(product.slice(0, -8));
    return Number.isSafeInteger(quotient) ? quotient : null;
};

const MAX_SAFE_INTEGER = 9007199254740991;

export const isNonNegativeSafeInteger = (value: any): boolean =>
    typeof value === 'number'
    && isFinite(value)
    && Math.floor(value) === value
    && value >= 0
    && value <= MAX_SAFE_INTEGER;

export const isPositiveFiniteNumber = (value: any): boolean =>
    typeof value === 'number' && isFinite(value) && value > 0;

// Synthetic property ids (e.g. "s-1-5") are the only non-numeric ids used by the
// markets service. Anything else must be a non-negative safe integer.
const WHITELISTED_STRING_ID = /^s-\d+-\d+$/;

export const isValidOrderIdProp = (value: any): boolean =>
    isNonNegativeSafeInteger(value)
    || (typeof value === 'string' && value.length <= 32 && WHITELISTED_STRING_ID.test(value));

export const sanitizeName = (name: string): string =>
    String(name).replace(/[^A-Za-z0-9_.-]/g, '_');

const LOGS_DIR = resolve('logs');

const resolveInsideLogsDir = (fileName: string): string => {
    const resolved = resolve(LOGS_DIR, fileName);
    const logsPrefix = LOGS_DIR.endsWith(sep) ? LOGS_DIR : LOGS_DIR + sep;
    if (!resolved.startsWith(logsPrefix)) {
        throw new Error(`Refusing to access path outside logs directory: ${fileName}`);
    }
    return resolved;
};

export type TLogType = "ORDER" | "TRADE";

interface IClosedOrders {
    uuid: string;
    timestamp: number;
    socket_id: string;
};

// A log file is `${type}-${market}-${DD-MM-YYYY}.log`. Markets are matched by exact name:
// "futures-1" is not a prefix of "futures-10", and the market name itself may contain "-".
const LOG_FILE_PATTERN = /^(ORDER|TRADE)-(.+)-\d{2}-\d{2}-\d{4}\.log$/;

// Synchronous, so the record is on disk when this returns. updateOrderLog reads and rewrites the
// file synchronously; an append still in flight could land between its read and its write and
// be lost.
export const saveLog = (name: string, type: TLogType, data: IHistoryTrade | TOrder | IClosedOrders) => {
    try {
        const date = moment().format('DD-MM-YYYY');
        const filePath = resolveInsideLogsDir(`${type}-${sanitizeName(name)}-${date}.log`);
        appendFileSync(filePath, `${JSON.stringify(data)}\n`);
    } catch (error: any) {
        console.log(error.message);
    }
};

// File names of one record type for the given market names, across all dates.
const marketLogFiles = (type: TLogType, names: string[]): string[] => {
    const markets = names.map(sanitizeName);
    return readdirSync(LOGS_DIR).filter(file => {
        const match = LOG_FILE_PATTERN.exec(file);
        return match !== null && match[1] === type && markets.indexOf(match[2]) !== -1;
    });
};

// One log line as a record, or null when it does not parse. A write torn by a crash leaves such a
// line; it must not hide the records around it, so every reader goes through this.
const parseLogLine = (line: string): any | null => {
    try {
        return JSON.parse(line);
    } catch (error) {
        return null;
    }
};

export const parseLogRecords = (text: string): any[] =>
    text.split('\n').map(parseLogLine).filter(record => record !== null);

// Every record of one type for the given market names, in file order.
export const readMarketLog = <T>(type: TLogType, names: string[]): T[] => {
    const records: T[] = [];
    marketLogFiles(type, names).forEach(file => {
        parseLogRecords(readFileSync(resolveInsideLogsDir(file), 'utf8')).forEach(record => records.push(record));
    });
    return records as T[];
};

// Sets the state of the ORDER record with this uuid in the market's log. Lines are rewritten as they
// were, except the one record, so a torn line is left in place.
export const updateOrderLog = (names: string[], uuid: string, type: "CANCALED" | "FILLED") => {
    try {
        const fileNamesList = marketLogFiles("ORDER", names);
        for (let i = 0; i < fileNamesList.length; i++) {
            const filePath = resolveInsideLogsDir(fileNamesList[i]);
            const lines = readFileSync(filePath, { encoding: "utf8" }).split('\n');
            const index = lines.findIndex(line => parseLogLine(line)?.uuid === uuid);
            if (index !== -1) {
                lines[index] = JSON.stringify({ ...parseLogLine(lines[index]), state: type });
                writeFileSync(filePath, lines.join('\n'));
                break;
            }
        }
    } catch (error) {
        console.log({ error });
    }
};
