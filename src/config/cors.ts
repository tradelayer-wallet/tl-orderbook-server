import { envConfig } from "./env.config";

// The single CORS decision for every surface of this server: the HTTP routes
// (fastify-cors) and the socket.io / engine.io handshake (cors).
//
// Returns the request origin when it is on the CORS_ORIGINS allowlist, otherwise
// null, in which case no CORS headers are sent. Matching is exact string
// equality; the opaque origin is configured and compared as lowercase `null`.
//
// Credentials are never enabled, so no response carries
// Access-Control-Allow-Credentials. Nothing here authenticates by cookie or HTTP
// auth, and an opaque `null` origin (sandboxed or file:// pages) must not be able
// to send credentials. Re-enabling credentials is a change to this module.
export const decideCorsOrigin = (requestOrigin: string | undefined): string | null => {
    if (!requestOrigin || envConfig.CORS_ORIGINS.indexOf(requestOrigin) === -1) return null;
    return requestOrigin;
};

type TOriginCallback = (err: Error | null, origin?: string | false) => void;

// Origin resolver shared by both adapters. `false` tells the library to send no
// CORS headers for this request.
const resolveOrigin = (requestOrigin: string | undefined, cb: TOriginCallback): void => {
    cb(null, decideCorsOrigin(requestOrigin) || false);
};

// Options for fastify-cors (registered on the HTTP server).
export const fastifyCorsOptions = {
    origin: resolveOrigin,
};

// Options for the socket.io server (passed to fastify-socket.io as `cors`).
export const socketIoCorsOptions = {
    origin: resolveOrigin,
    methods: ["GET", "POST"],
};

// Engine.io handshake gate (passed as `allowRequest`). CORS headers only govern
// browser XHR, so they do not restrict a WebSocket upgrade. This gate applies the
// same decision to every new handshake, polling or WebSocket. A handshake carrying
// no Origin header is not a cross-origin browser request, so it is not refused here.
export const socketIoAllowRequest = (
    req: { headers: { origin?: string } },
    cb: (message: string | null, success: boolean) => void,
): void => {
    const origin = req.headers.origin;
    const allowed = !origin || decideCorsOrigin(origin) !== null;
    cb(allowed ? null : 'Origin not allowed', allowed);
};
