import { MarketsManager } from "./manager.class";

export const initMarketsService = () => {
    marketsManager = new MarketsManager();
};

export let marketsManager: MarketsManager;