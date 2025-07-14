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

export class ChannelSwap {
  private ready!: (v: IResultChannelSwap) => void;
  private readonly buyerId: string;
  private readonly clientMgr: SocketEventManager;
  private readonly dealerMgr: SocketEventManager;
  private closed = false;

  constructor(
    private client: Websocket,
    private dealer: Websocket,
    private tradeInfo: ITradeInfo,
    private unfilled: TOrder
  ) {
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

    this.clientMgr.on(clientSwapEvt, (swap: SwapEvent) => {
      console.log('[Relay] client → dealer', clientSwapEvt, JSON.stringify(swap));
      this.dealerMgr.emit(clientSwapEvt, swap);
    });

    this.dealerMgr.on(dealerSwapEvt, (swap: SwapEvent) => {
      console.log('[Relay] dealer → client', dealerSwapEvt, JSON.stringify(swap));
      this.clientMgr.emit(dealerSwapEvt, swap);
    });
  }

  /** Watch for BUYER:STEP6 or TERMINATE_TRADE and resolve/close */
  private monitorTerminalEvents() {
    const handler: EventHandler = (swap: SwapEvent) => {
      const { eventName, socketId, data } = swap;
      console.log('[Monitor] swap event:', JSON.stringify(swap));

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
  }
}
