import HyperExpress from 'hyper-express';
const router = new HyperExpress.Router();
import { marketsManager } from '../services/markets';

const isNet = (n: string) => ['BTC','LTC','LTCTEST'].includes(n);

router.get('/spot/:network', async (req, res) => {
    try {
    const net = req.params.network.toUpperCase();
    if (!isNet(net)) return res.status(400).json({ error: 'bad network' });
    const result = await marketsManager.getAvailableSpotMarkets(net); // <— pass net
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/futures/:network', async (req, res) => {
     try {
        const net = req.params.network.toUpperCase();
        if (!isNet(net)) return res.status(400).json({ error: 'bad network' });
        const result = await marketsManager.getAvailableFuturesMarkets(net); // <— pass net
        res.json(result);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
});

export { router as marketsRoutes };
