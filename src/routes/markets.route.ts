import { FastifyInstance } from "fastify";
import { marketsManager } from "../services/markets";

// The markets service answers with an IResult and never throws, so the routes return it as it is.
export const marketsRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/spot', async () => marketsManager.getAvailableSpotMarkets());

    fastify.get('/futures', async () => marketsManager.getAvailableFuturesMarkets());
    done();
}
