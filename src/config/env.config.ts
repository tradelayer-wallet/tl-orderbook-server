import * as dotenv from 'dotenv';
import { join } from 'path';

const envFile = process.env.NODE_ENV === 'production' ? 'production.env' : 'development.env';
const path = join('environments', envFile);
dotenv.config({ path });

const parsePositiveInt = (value: any, fallback: number): number => {
    const parsed = parseInt(value, 10);
    return isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Origins the shipped wallet FE actually sends:
//  - `null` (the literal opaque origin): the Electron UI is loaded from file://,
//    which serializes its origin as `null` — same policy as the wallet's own
//    socket.io server (see tradelayer-wallet wallet-server socket.service.ts),
//    which also admits `null` for the file:// UI.
//  - the layerwallet.com web origins (previously hardcoded for socket.io).
// Override with CORS_ORIGINS (comma-separated). Set CORS_ORIGINS=off to deny
// all cross-origin access.
export const DEFAULT_CORS_ORIGINS = ['null', 'https://layerwallet.com', 'https://www.layerwallet.com'];

const rawCorsOrigins = (process.env.CORS_ORIGINS || '').trim();
const isNullOrigin = (origin: string) => /^null$/i.test(origin);

export const envConfig: {
    SERVER_PORT: number;
    HTTP_PORT: number;
    SWAP_TIMEOUT_MS: number;
    ADMIN_API_KEY: string;
    CORS_ORIGINS: string[];
} = {
    SERVER_PORT: parseInt(process.env.SERVER_PORT),
    HTTP_PORT: parseInt(process.env.HTTP_PORT),
    // Max time a swap may stay open before it is aborted and the matched order unlocked.
    SWAP_TIMEOUT_MS: parsePositiveInt(process.env.SWAP_TIMEOUT_MS, 120000),
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
