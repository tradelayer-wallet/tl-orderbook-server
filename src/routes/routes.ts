import HyperExpress from 'hyper-express';
import { logsRouter} from './logs.route';
import { marketsRoutes } from './markets.route';

export function handleRoutes(server: HyperExpress.Server) {
    // CORS middleware
    server.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header(
            'Access-Control-Allow-Headers',
            'Origin, X-Requested-With, Content-Type, Accept'
        );
        res.header(
            'Access-Control-Allow-Methods',
            'GET, POST, PUT, DELETE, OPTIONS'
        );
        if (req.method === 'OPTIONS') {
            res.status(204).send(); // No content for OPTIONS requests
        } else {
            next();
        }
    });

    // Use routers with prefixes
    server.use('/markets', marketsRoutes);
    server.use('/logs', logsRouter);
}
