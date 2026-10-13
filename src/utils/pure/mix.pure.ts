import { appendFile, readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, sep } from "path";
import { IHistoryTrade, TOrder } from "../types/orderbook.types";
import * as moment from 'moment';

export const safeNumber = (n: number) => parseFloat((n).toFixed(6));

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

export const saveLog = (name: string, type: TLogType, data: IHistoryTrade | TOrder | IClosedOrders) => {
    try {
        const date = moment().format('DD-MM-YYYY');
        const safeName = sanitizeName(name);
        const filePath = resolveInsideLogsDir(`${type}-${safeName}-${date}.log`);
        const _data = `${JSON.stringify(data)}\n`;
        appendFile(filePath, _data, (err) => {
            if (err) console.log(err.message);
        });
    } catch (error: any) {
        console.log(error.message);
    }
};

export const updateOrderLog = (name: string, uuid: string, type: "CANCALED" | "FILLED") => {
    try {
        const safeName = sanitizeName(name);
        const data = readdirSync(LOGS_DIR);
        const fileNamesList = data.filter(q => q.includes(safeName));
        for (let i = 0; i < fileNamesList.length; i++) {
            const file = fileNamesList[i];
            const filePath = resolveInsideLogsDir(file);
            const fileData = readFileSync(filePath, { encoding: "utf8" });
            const arrayData = fileData.split(`\n`).slice(0, -1).map(q => JSON.parse(q) as TOrder);
            const existing = arrayData.find(q => q.uuid === uuid);
            if (existing) {
                existing['state'] = type;
                writeFileSync(filePath, `${arrayData.map(q => JSON.stringify(q)).join('\n')}\n`)
                break;
            }

        }
    } catch (error) {
        console.log({ error });
    }
};
