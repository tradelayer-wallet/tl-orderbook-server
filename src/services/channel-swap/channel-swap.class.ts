// channel-swap.class.ts
import { Websocket } from 'hyper-express';
import { SocketEventManager } from './socket-event-manager';
import { IResultChannelSwap } from '../../utils/types/mix.types';
import { ITradeInfo, TOrder } from '../../utils/types/orderbook.types';

export class SwapEvent {
  constructor(
    public eventName: string,
    public socketId: string,
    public data: any
  ) {}
}

const swapEventName = 'swap';

/**
 * Tag a relayed swap payload with the trade it belongs to. Object payloads (multisig data, PSBTs, UTXOs)
 * gain a `tradeUUID` field; an absent payload becomes `{ tradeUUID }`. Any other payload (the final txid and
 * the TERMINATE_TRADE reason are plain strings; arrays and numbers likewise) is forwarded unchanged, because
 * the swappers read those as `data` itself and spreading a string would turn it into `{"0":"c","1":"6",...}`.
 */
export function withTradeUUID(data: any, tradeUUID: string): any {
  if (data === undefined || data === null) return { tradeUUID };
  if (typeof data === 'object' && !Array.isArray(data)) return { ...data, tradeUUID };
  return data;
}

// Per-message payload logging is off by default (set OB_DEBUG_LOG=1 to enable).
const DEBUG_LOG = process.env.OB_DEBUG_LOG === '1';
// A swap that never reaches BUYER:STEP6 / TERMINATE_TRADE is torn down after this long (default 30 min).
const SWAP_TTL_MS = Number(process.env.OB_SWAP_TTL_MS) > 0 ? Number(process.env.OB_SWAP_TTL_MS) : 30 * 60 * 1000;


// ---- Deduplication singletons ---- //
const activeSwaps = new Map<string, ChannelSwap>();
const completedSteps = new Set<string>();

function getTradeUUID(tradeInfo: ITradeInfo): string {
  return `${tradeInfo.buyer.uuid}-${tradeInfo.seller.uuid}`
}

function shouldProcessStep(tradeUUID: string, socketId: string, eventName: string): boolean {
  const key = `${tradeUUID}:${socketId}:${eventName}`;
  if (DEBUG_LOG) console.log('inside should process step '+key+' '+completedSteps.has(key))
  if (completedSteps.has(key)) return false;
  completedSteps.add(key);
  return true;
}

function cleanUpStepsForTrade(tradeUUID: string) {
  for (const key of completedSteps) {
    if (key.startsWith(`${tradeUUID}:`)) completedSteps.delete(key);
  }
}

export class ChannelSwap {
  private ready!: (v: IResultChannelSwap) => void;
  private readonly buyerId: string;
  private readonly clientMgr: SocketEventManager;
  private readonly dealerMgr: SocketEventManager;
  private closed = false;
  private duplicate = false;
  private tradeUUID: string;
  private ttlTimer: NodeJS.Timeout | null = null;
  private readonly onClientClose = () => this.finish('client disconnected');
  private readonly onDealerClose = () => this.finish('dealer disconnected');

  constructor(
    private client: Websocket,
    private dealer: Websocket,
    private tradeInfo: ITradeInfo,
    private unfilled: TOrder
  ) {

    this.tradeUUID = getTradeUUID(tradeInfo);
    if (DEBUG_LOG) console.log('tradeInfo inside channel swap mgmt '+JSON.stringify(tradeInfo))
    // --- DEDUPLICATION GUARD ---
    if (activeSwaps.has(this.tradeUUID)) {
      if (DEBUG_LOG) console.log(`[SwapGuard] Swap already active for ${this.tradeUUID}, skipping duplicate.`);
      // Inert instance: owns no listeners, onReady() resolves with an error.
      this.closed = true;
      this.duplicate = true;
      return;
    }
    activeSwaps.set(this.tradeUUID, this);
    // Wrap each HyperExpress socket with our event manager
    this.clientMgr = new SocketEventManager(client);
    this.dealerMgr = new SocketEventManager(dealer);
    this.buyerId = tradeInfo.buyer.socketId;

    // Tear the swap down if either peer drops or the swap never completes, so its listeners
    // and dedupe entries cannot accumulate on long-lived sockets.
    client.once('close', this.onClientClose);
    dealer.once('close', this.onDealerClose);
    this.ttlTimer = setTimeout(() => this.finish('swap timeout'), SWAP_TTL_MS);
    this.ttlTimer.unref?.();

    this.openChannel();
  }


  /** resolves when BUYER:STEP6 or TERMINATE_TRADE received */
  onReady(): Promise<IResultChannelSwap> {
    return new Promise<IResultChannelSwap>(res => {
      this.ready = res;
      if (this.duplicate) res({ error: 'duplicate swap' });
    });
  }

  /* ------------------------------------------------------------------ */
  /*                          Private helpers                           */
  /* ------------------------------------------------------------------ */

  private openChannel() {
    this.pipeSwapEvents();   // bidirectional relay; resolves on the terminal steps

    const trade = { tradeInfo: this.tradeInfo, unfilled: this.unfilled };
    if (DEBUG_LOG) console.log('channel config '+this.buyerId)
    // Send 'new-channel' to each side
    this.clientMgr.emit('new-channel', {
      ...trade,
      isBuyer: (this.client as any).id === this.buyerId
    });

    this.dealerMgr.emit('new-channel', {
      ...trade,
      isBuyer: (this.dealer as any).id === this.buyerId
    });
  }

  /** Relay `socketId::swap` messages between the two peers (exactly like legacy) */
 private pipeSwapEvents() {
  const clientSwapEvt = `${(this.client as any).id}::${swapEventName}`;
  const dealerSwapEvt = `${(this.dealer as any).id}::${swapEventName}`;

  this.clientMgr.on(clientSwapEvt, (raw: any) => {
    if (DEBUG_LOG) console.log('client pipe swap '+JSON.stringify(raw))
    const eventName = raw.eventName ?? 'UNKNOWN_STEP';
     if (!shouldProcessStep(this.tradeUUID, (this.client as any).id, eventName)) {
        if (DEBUG_LOG) console.log(`[SwapGuard] client step ${eventName} already handled for ${this.tradeUUID}`);
        return;
      }
    const socketId = (this.client as any).id;
    const payload = new SwapEvent(eventName, socketId, withTradeUUID(raw.data, this.tradeUUID));
    if (DEBUG_LOG) console.log('[Relay] client → dealer', clientSwapEvt, JSON.stringify(payload));
    this.dealerMgr.emit(clientSwapEvt, payload);
    this.checkTerminal(payload);
  });

  this.dealerMgr.on(dealerSwapEvt, (raw: any) => {
    if (DEBUG_LOG) console.log('dealer pipe swap '+JSON.stringify(raw))
    const eventName = raw.eventName ?? 'UNKNOWN_STEP';
    if (!shouldProcessStep(this.tradeUUID, (this.dealer as any).id, eventName)) {
        if (DEBUG_LOG) console.log(`[SwapGuard] dealer step ${eventName} already handled for ${this.tradeUUID}`);
        return;
      }
    const payload = new SwapEvent(eventName, (this.dealer as any).id, raw.data ?? raw);
    if (DEBUG_LOG) console.log('[Relay] dealer → client', dealerSwapEvt, JSON.stringify(payload));
    this.clientMgr.emit(dealerSwapEvt, payload);
    this.checkTerminal(payload);
  });
}


  /**
   * Resolve and close on BUYER:STEP6 (data is the final txid) or TERMINATE_TRADE (data is the reason).
   * Called from the relay after the step is forwarded, so the peer still receives it. The peers only ever
   * send `<socketId>::swap`; a listener on the bare `swap` event never fired, and every swap ended by TTL.
   */
  private checkTerminal(swap: SwapEvent) {
    if (this.closed) return;
    const { eventName, socketId, data } = swap;
    if (eventName === 'BUYER:STEP6') {
      this.ready?.({ data: { txid: data } });
      this.close();
    } else if (eventName === 'TERMINATE_TRADE') {
      this.ready?.({ error: data, socketId });
      this.close();
    }
  }

  /** Abort path (timeout / peer disconnect): resolve the pending result with an error, then clean up. */
  private finish(reason: string) {
    if (this.closed) return;
    this.ready?.({ error: reason });
    this.close();
  }

  /** Clean up listeners & managers */
  private close() {
    if (this.closed) return;
    this.closed = true;
    if (this.ttlTimer) { clearTimeout(this.ttlTimer); this.ttlTimer = null; }
    this.client.removeListener('close', this.onClientClose);
    this.dealer.removeListener('close', this.onDealerClose);
    this.clientMgr.dispose();
    this.dealerMgr.dispose();
    activeSwaps.delete(this.tradeUUID);
    cleanUpStepsForTrade(this.tradeUUID);
  }
}
