// channel-swap.class.ts
import { Websocket } from 'hyper-express';
import { SocketEventManager, EventHandler } from './socket-event-manager';
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


// ---- Deduplication singletons ---- //
const activeSwaps = new Map<string, ChannelSwap>();
const completedSteps = new Set<string>();

function getTradeUUID(tradeInfo: ITradeInfo): string {
  return `${tradeInfo.buyer.uuid}-${tradeInfo.seller.uuid}`
}

function shouldProcessStep(tradeUUID: string, socketId: string, eventName: string): boolean {
  const key = `${tradeUUID}:${socketId}:${eventName}`;
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
  private tradeUUID: string;

  constructor(
    private client: Websocket,
    private dealer: Websocket,
    private tradeInfo: ITradeInfo,
    private unfilled: TOrder
  ) {

    this.tradeUUID = getTradeUUID(tradeInfo);

    // --- DEDUPLICATION GUARD ---
    if (activeSwaps.has(this.tradeUUID)) {
      console.log(`[SwapGuard] Swap already active for ${this.tradeUUID}, skipping duplicate.`);
      // No-op, or could throw or return early if instantiated directly.
      return;
    }
    activeSwaps.set(this.tradeUUID, this);
    // Wrap each HyperExpress socket with our event manager
    this.clientMgr = new SocketEventManager(client);
    this.dealerMgr = new SocketEventManager(dealer);
    this.buyerId = tradeInfo.buyer.socketId;

    this.openChannel();
  }


  /** resolves when BUYER:STEP6 or TERMINATE_TRADE received */
  onReady(): Promise<IResultChannelSwap> {
    return new Promise<IResultChannelSwap>(res => (this.ready = res));
  }

  /* ------------------------------------------------------------------ */
  /*                          Private helpers                           */
  /* ------------------------------------------------------------------ */

  private openChannel() {
    this.pipeSwapEvents();   // bidirectional relay
    this.monitorTerminalEvents();

    const trade = { tradeInfo: this.tradeInfo, unfilled: this.unfilled };

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
    console.log('client pipe swap '+JSON.stringify(raw))
    const eventName = raw.eventName ?? 'UNKNOWN_STEP';
     if (!shouldProcessStep(this.tradeUUID, (this.client as any).id, eventName)) {
        console.log(`[SwapGuard] client step ${eventName} already handled for ${this.tradeUUID}`);
        return;
      }
    const payload = new SwapEvent(eventName, (this.client as any).id, raw.data ?? raw);
    console.log('[Relay] client → dealer', clientSwapEvt, JSON.stringify(payload));
    this.dealerMgr.emit(clientSwapEvt, payload);
  });

  this.dealerMgr.on(dealerSwapEvt, (raw: any) => {
    console.log('dealer pipe swap '+JSON.stringify(raw))
    const eventName = raw.eventName ?? 'UNKNOWN_STEP';
    if (!shouldProcessStep(this.tradeUUID, (this.dealer as any).id, eventName)) {
        console.log(`[SwapGuard] dealer step ${eventName} already handled for ${this.tradeUUID}`);
        return;
      }
    const payload = new SwapEvent(eventName, (this.dealer as any).id, raw.data ?? raw);
    console.log('[Relay] dealer → client', dealerSwapEvt, JSON.stringify(payload));
    this.clientMgr.emit(dealerSwapEvt, payload);
  });
}


  /** Watch for BUYER:STEP6 or TERMINATE_TRADE and resolve/close */
  private monitorTerminalEvents() {
    const handler: EventHandler = (swap: SwapEvent) => {
      const { eventName, socketId, data } = swap;
      console.log('[Monitor] swap event:', JSON.stringify(swap));

       // Use step guard even here for full deduplication
      if (!shouldProcessStep(this.tradeUUID, socketId, eventName)) {
        console.log(`[SwapGuard] terminal step ${eventName} already handled for ${this.tradeUUID}`);
        return;
      }

      if (eventName === 'BUYER:STEP6') {
        this.ready?.({ data: { txid: data } });
        this.close();
      }

      if (eventName === 'TERMINATE_TRADE') {
        this.ready?.({ error: data, socketId });
        this.close();
      }
    };

    this.clientMgr.on(swapEventName, handler);
    this.dealerMgr.on(swapEventName, handler);
  }

  /** Clean up listeners & managers */
  private close() {
    if (this.closed) return;
    this.closed = true;
    this.clientMgr.dispose();
    this.dealerMgr.dispose();
    activeSwaps.delete(this.tradeUUID);
    cleanUpStepsForTrade(this.tradeUUID);
  }
}
