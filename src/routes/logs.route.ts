// logs.route.ts
import HyperExpress from 'hyper-express';
import { readFileSync, readdirSync } from "fs";
import { socketManager } from '../services/socket'; // Updated import
import moment from 'moment';

const logsRouter = new HyperExpress.Router();

logsRouter.get('/sessions', async (req, res) => {
    try {
        const sessions = socketManager.liveSessions;
        const count = sessions.length;
        res.json({ data: { sessions, count } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

logsRouter.get('/orders', async (req, res) => {
    try {
        const _path = `logs/`;
        const today = moment().format('DD-MM-YYYY');
        const yesterday = moment().subtract(1, 'days').format('DD-MM-YYYY');
        const files = readdirSync(_path)
            .filter(f => f.includes(today) || f.includes(yesterday));
        const resArray = [];
        files.forEach(f => {
            const filePath = _path + f;
            const fileData = readFileSync(filePath, 'utf8');
            fileData
                .split('\n')
                .filter(line => line.trim() !== '')
                .forEach(q => resArray.push(JSON.parse(q)));
        });
        res.json({ data: resArray });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export { logsRouter };