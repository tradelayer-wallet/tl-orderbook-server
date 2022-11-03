import { FastifyInstance } from "fastify";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { socketService } from "../services/socket";
import { ELogType, logsPath } from "../utils/pure/mix.pure";
import { IResult } from "../utils/types/mix.types";

export const logsRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
    fastify.get('/sessions', async (request, reply) => {
        try {
            const sessions = socketService.liveSessions;
            const count = sessions.length;
            const result: IResult = { data: { sessions, count } };
            reply.send(result);
        } catch (error) {
            reply.send({ error: error.message });
        }
    });

    Object.keys(ELogType)
        .forEach(key => {
            fastify.get(`/${key.toLowerCase()}`, async (request, reply) => {
                try {
                    const type = ELogType[key];
                    const path = `${logsPath}/${type}.log`;
                    const isExist = existsSync(path);
                    if (!isExist) {
                        const result: IResult = { data: [] };
                        reply.send(result);
                        return;
                    } else {
                        const readyRes = readFileSync(path, { encoding: 'utf8' });
                        const logArray = readyRes
                            .split('\n')
                            .slice(0, -1);
                        const finalArr = logArray.map(l => JSON.parse(l));
                        const result: IResult = { data: finalArr };
                        reply.send(result);
                    }
                } catch (error) {
                    reply.send({ error: error.message });
                }
            });
        });
    done();
};
