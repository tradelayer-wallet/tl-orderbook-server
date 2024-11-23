import HyperExpress from 'hyper-express';
const router = new HyperExpress.Router();
import { marketsManager } from '../services/markets';



router.get('/spot', async (req, res) => {
    try {
        const result = marketsManager.getAvailableSpotMarkets();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/futures', async (req, res) => {
    try {
        const result = marketsManager.getAvailableFuturesMarkets();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export { router as marketsRoutes };
