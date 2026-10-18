import { appendFileSync, closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "fs";
import { resolve, sep } from "path";
import { IHistoryTrade, TOrder } from "../types/orderbook.types";
import * as moment from 'moment';

const MAX_SAFE_INTEGER = 9007199254740991;

export const isNonNegativeSafeInteger = (value: any): boolean =>
    typeof value === 'number'
    && isFinite(value)
    && Math.floor(value) === value
    && value >= 0
    && value <= MAX_SAFE_INTEGER;

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

const TAIL_CHUNK_BYTES = 64 * 1024;

// The records of one log file that pass `keep`, newest first, at most `limit`. The file is read from its
// end in chunks and reading stops once `limit` records are found. Lines are split on the newline byte
// and decoded one by one, so a multi-byte character or a long record that spans chunks stays whole.
const tailRecords = (filePath: string, limit: number, keep: (record: any) => boolean): any[] => {
    const fd = openSync(filePath, 'r');
    try {
        const records: any[] = [];
        const pushLine = (bytes: string) => {
            const record = parseLogLine(Buffer.from(bytes, 'latin1').toString('utf8'));
            if (record !== null && keep(record)) records.push(record);
        };
        let offset = fstatSync(fd).size;
        // The first line read so far: its start may be in the chunk before, not read yet.
        let head = '';
        while (records.length < limit) {
            if (offset === 0) {
                pushLine(head);
                break;
            }
            const length = Math.min(TAIL_CHUNK_BYTES, offset);
            offset -= length;
            const chunk = Buffer.alloc(length);
            if (readSync(fd, chunk, 0, length, offset) !== length) throw new Error(`short read of ${filePath}`);
            const lines = (chunk.toString('latin1') + head).split('\n');
            head = lines.shift();
            for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) pushLine(lines[i]);
        }
        return records;
    } finally {
        closeSync(fd);
    }
};

// The newest `limit` records of one type for the given market names that pass `keep`, newest first.
// A market has one log file per day, and a day's records are all newer than an earlier day's. So the
// files are read from the newest day back, and reading stops after the day that completes `limit`
// records: a read costs the records it returns, not the size of the logs.
export const readNewestRecords = <T>(type: TLogType, names: string[], limit: number, keep: (record: any) => boolean): T[] => {
    const days = new Map<string, string[]>();
    marketLogFiles(type, names).forEach(file => {
        // The file name ends with DD-MM-YYYY; the key sorts as YYYY-MM-DD.
        const day = file.slice(-14, -4).split('-').reverse().join('-');
        days.set(day, [...(days.get(day) || []), file]);
    });
    const records: T[] = [];
    for (const day of Array.from(days.keys()).sort().reverse()) {
        days.get(day).forEach(file => records.push(...tailRecords(resolveInsideLogsDir(file), limit, keep)));
        if (records.length >= limit) break;
    }
    return records;
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
