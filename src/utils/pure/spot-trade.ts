// Pure spot-trade arithmetic shared by the exec handler and its tests (no imports, no I/O).

export const PRICE_SCALE = 100;   // engine ticks -> UI price
export const QTY_SCALE   = 1e8;   // engine sats  -> UI amount

export type TakerSide = 'BUY' | 'SELL';

export interface IMatchedSpotProps {
  propIdDesired: number;
  propIdForSale: number;
  amountDesired: number;
  amountForSale: number;
}

/**
 * Pair the property ids and amounts of one matched spot slice the way the swapper consumes them.
 *
 * Order convention (wallet): a BUY spends the quote property (id_for_sale) for the base property
 * (id_desired); a SELL spends the base property for the quote property. `quantity` is in base units
 * and `price` is quote per base, as the native engine reports them.
 *
 * Swapper convention: the swap's buyer offers propIdForSale/amountForSale and wants propIdDesired/
 * amountDesired; the swap's seller commits propIdDesired/amountDesired. So whichever side is the taker:
 *   propIdDesired = base,  amountDesired = quantity
 *   propIdForSale = quote, amountForSale = quantity * price
 *
 * The quote amount is computed on integer base-unit and price-tick counts (round half up to one
 * unit), then scaled back, so the result carries no binary float drift.
 */
export function matchedSpotProps(
  takerSide: TakerSide,
  takerIdForSale: number,
  takerIdDesired: number,
  quantity: number,
  price: number,
): IMatchedSpotProps {
  const base  = takerSide === 'BUY' ? takerIdDesired : takerIdForSale;
  const quote = takerSide === 'BUY' ? takerIdForSale : takerIdDesired;

  const qtyUnits   = BigInt(Math.round(quantity * QTY_SCALE));
  const priceTicks = BigInt(Math.round(price * PRICE_SCALE));
  const scale      = BigInt(PRICE_SCALE);
  const quoteUnits = (qtyUnits * priceTicks + scale / 2n) / scale;

  return {
    propIdDesired: base,
    propIdForSale: quote,
    amountDesired: Number(qtyUnits) / QTY_SCALE,
    amountForSale: Number(quoteUnits) / QTY_SCALE,
  };
}
