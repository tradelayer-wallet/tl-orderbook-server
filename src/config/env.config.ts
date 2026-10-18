import * as dotenv from 'dotenv';
import { join } from 'path';

const envFile = process.env.NODE_ENV === 'production' ? 'production.env' : 'development.env';
const path = join('environments', envFile);
dotenv.config({ path });

const parsePositiveInt = (value: any, fallback: number): number => {
    const parsed = parseInt(value, 10);
    return isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Default CORS allowlist (enforced by config/cors.ts):
//  - `null` (the literal opaque origin): the Electron UI is loaded from file://,
//    which serializes its origin as `null`. Compatibility only; no credentials
//    are ever sent to it.
//  - the layerwallet.com web origins.
// Override with CORS_ORIGINS (comma-separated). Set CORS_ORIGINS=off to deny
// all cross-origin access.
export const DEFAULT_CORS_ORIGINS = ['null', 'https://layerwallet.com', 'https://www.layerwallet.com'];

const rawCorsOrigins = (process.env.CORS_ORIGINS || '').trim();
const isNullOrigin = (origin: string) => /^null$/i.test(origin);

export const envConfig: {
    SERVER_PORT: number;
    HTTP_PORT: number;
    SWAP_TIMEOUT_MS: number;
    SWAP_SIGNED_WINDOW_MS: number;
    ADMIN_API_KEY: string;
    CORS_ORIGINS: string[];
    MAX_ORDERBOOKS: number;
    MAX_OPEN_ORDERS_PER_SOCKET: number;
    MAX_OPEN_ORDERS: number;
    MAX_CONNECTIONS_PER_IP: number;
} = {
    SERVER_PORT: parseInt(process.env.SERVER_PORT),
    HTTP_PORT: parseInt(process.env.HTTP_PORT),
    // Max time a swap may stay open before it is aborted and the matched order unlocked.
    SWAP_TIMEOUT_MS: parsePositiveInt(process.env.SWAP_TIMEOUT_MS, 120000),
    // Max time between SELLER:STEP5 and the buyer's BUYER:STEP6 report. Once the seller has signed,
    // the buyer may broadcast at any time, so the window is capped and the session then ends as
    // expired-unverified. Capped at one hour.
    SWAP_SIGNED_WINDOW_MS: Math.min(parsePositiveInt(process.env.SWAP_SIGNED_WINDOW_MS, 600000), 3600000),
    // Max number of distinct orderbooks (market pairs) the server holds. Every new pair
    // is a new in-memory book plus log files, and any client can name a pair, so this
    // bounds the registry. Creating a book beyond the cap is refused explicitly.
    MAX_ORDERBOOKS: parsePositiveInt(process.env.MAX_ORDERBOOKS, 256),
    // Resting orders. Each order is held in memory and sent to clients on every book change, and
    // any number of sockets can connect, so the per-account and the total are both bounded.
    MAX_OPEN_ORDERS_PER_SOCKET: parsePositiveInt(process.env.MAX_OPEN_ORDERS_PER_SOCKET, 500),
    MAX_OPEN_ORDERS: parsePositiveInt(process.env.MAX_OPEN_ORDERS, 100000),
    // Live sockets per address. Sockets are not authenticated and the per-socket limits are
    // per socket, so this is the bound on how many of them one client can hold.
    MAX_CONNECTIONS_PER_IP: parsePositiveInt(process.env.MAX_CONNECTIONS_PER_IP, 20),
    // When unset, the /logs admin endpoints are disabled entirely (fail closed).
    ADMIN_API_KEY: (process.env.ADMIN_API_KEY || '').trim(),
    // Comma-separated allowlist of browser origins. Unset = the wallet FE
    // defaults above. `off` = all cross-origin access denied.
    CORS_ORIGINS: !rawCorsOrigins
        ? DEFAULT_CORS_ORIGINS
        : rawCorsOrigins.toLowerCase() === 'off'
            ? []
            : rawCorsOrigins
                .split(',')
                .map(origin => origin.trim())
                .filter(origin => origin.length > 0)
                // the opaque origin is always serialized as lowercase `null`
                .map(origin => isNullOrigin(origin) ? 'null' : origin),
};
