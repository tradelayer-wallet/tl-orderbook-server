import * as dotenv from 'dotenv';
import { join } from 'path';

const envFile = process.env.NODE_ENV === 'production' ? 'production.env' : 'development.env';
const path = join('environments', envFile);
dotenv.config({ path });

const parsePositiveInt = (value: any, fallback: number): number => {
    const parsed = parseInt(value, 10);
    return isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

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
    // Comma-separated allowlist of browser origins. Empty = CORS disabled (deny all cross-origin).
    CORS_ORIGINS: (process.env.CORS_ORIGINS || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(origin => origin.length > 0),
};
