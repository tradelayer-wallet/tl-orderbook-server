import { FastifyInstance } from "fastify";
import { marketsManager } from "../services/markets";
import { IResult } from "../utils/types/mix.types";

export const marketsRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/spot', async (request, reply) => {
        try {
            const result: IResult = marketsManager.getAvailableSpotMarkets();
            reply.send(result);
        } catch (error) {
            reply.send({ error: error.message });
        }
    });

    fastify.get('/futures', async (request, reply) => {
        try {
            const result: IResult = marketsManager.getAvailableFuturesMarkets();
            reply.send(result);
        } catch (error) {
            reply.send({ error: error.message });
        }
    });
    done();
}