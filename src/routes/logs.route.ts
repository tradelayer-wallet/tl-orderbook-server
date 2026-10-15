import { timingSafeEqual } from "crypto";
import { FastifyInstance, FastifyRequest } from "fastify";
import { readFileSync, readdirSync } from "fs";
import { parseLogRecords } from "../utils/pure/mix.pure";
import moment = require("moment");
import { envConfig } from "../config/env.config";
import { socketService } from "../services/socket";
import { IResult } from "../utils/types/mix.types";

const isAuthorized = (request: FastifyRequest): boolean => {
    const apiKey = envConfig.ADMIN_API_KEY;
    if (!apiKey) return false;
    const provided = request.headers['x-api-key'];
    if (typeof provided !== 'string') return false;
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(apiKey);
    return providedBuffer.length === expectedBuffer.length
        && timingSafeEqual(providedBuffer, expectedBuffer);
};

export const logsRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    // Fail closed: when ADMIN_API_KEY is not configured the endpoints are not
    // registered at all and answer 404, instead of leaking session/order data.
    if (!envConfig.ADMIN_API_KEY) {
        console.log('ADMIN_API_KEY is not set: /logs/sessions and /logs/orders are disabled');
        done();
        return;
    }

    fastify.get('/sessions', async (request, reply) => {
        if (!isAuthorized(request)) {
            reply.code(401);
            return { error: 'Unauthorized' };
        }
        try {
            const sessions = socketService.liveSessions;
            const count = sessions.length;
            const result: IResult = { data: { sessions, count } };
            reply.send(result);
        } catch (error) {
            reply.send({ error: error.message });
        }
    });

    fastify.get('/orders', async (request, reply) => {
        if (!isAuthorized(request)) {
            reply.code(401);
            return { error: 'Unauthorized' };
        }
        try {
            const _path = `logs/`;
            const today = moment()
                .format('DD-MM-YYYY');
            const yesterday = moment()
                .subtract(1, 'days')
                .format('DD-MM-YYYY');
            const files = readdirSync(_path)
                .filter(f => f.includes(today) || f.includes(yesterday));
            const resArray = [];
            files.forEach(f => {
                parseLogRecords(readFileSync(_path + f, 'utf8')).forEach(record => resArray.push(record));
            });
            const result: IResult = { data: resArray };
            reply.send(result);
        } catch (error) {
            reply.send({ error: error.message });
        }
    });

    done();
};
