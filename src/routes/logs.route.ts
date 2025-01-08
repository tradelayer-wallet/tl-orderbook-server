import { FastifyInstance } from "fastify";
import { readFileSync, existsSync, writeFileSync, readdirSync } from "fs";
import moment = require("moment");
import { socketService } from "../services/socket";
import { IResult } from "../utils/types/mix.types";

export const logsRoutes = (fastify: FastifyInstance, opts: any, done: any) => {
   fastify.get('/sessions', async (request, reply) => {
    try {
        const sessions = SocketManager.liveSessions;
        const count = sessions.length;
        const result: IResult = { data: { sessions, count } };
        reply.send(result);
    } catch (error) {
        reply.send({ error: error.message });
    }
});


    fastify.get('/orders', async (request, reply) => {
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
                const filePath = _path + f;
                readFileSync(filePath, 'utf8')
                    .split('\n')
                    .slice(0, -1)
                    .forEach(q => resArray.push(JSON.parse(q)));
            });
            const result: IResult = { data: resArray };
            reply.send(result);
        } catch (error) {
            reply.send({ error: error.message });
        }
    });

    done();
};
