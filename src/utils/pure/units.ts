// Integer base units on the wire (protocol v2, protocol-v2.md B.1). A quantity is a safe integer:
// 1e-8 of a whole token for an order amount, and sats per whole token for a price. Nothing on the
// wire is a float or a decimal string, so the rules below are exact.
export const UNIT_SCALE = 100000000;

export const isWireUnits = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// Decimal product of two non-negative integers given as digit strings (no BigInt: the build
// targets ES5). Returns the digit string without leading zeros.
const mulDigitStrings = (x: string, y: string): string => {
    const xs = x.split('').reverse().map(Number);
    const ys = y.split('').reverse().map(Number);
    const out: number[] = [];
    for (let k = 0; k < xs.length + ys.length; k++) out.push(0);
    for (let i = 0; i < xs.length; i++) {
        for (let j = 0; j < ys.length; j++) out[i + j] += xs[i] * ys[j];
    }
    for (let k = 0; k < out.length - 1; k++) {
        out[k + 1] += Math.floor(out[k] / 10);
        out[k] = out[k] % 10;
    }
    return out.reverse().join('').replace(/^0+(?=\d)/, '');
};

// The satoshi value of a trade: amountUnits * priceSats / UNIT_SCALE, exact. Null when the quotient
// is not a whole number of satoshis or not a safe integer. Such a match is refused, never rounded.
export const valueSats = (amountUnits: number, priceSats: number): number | null => {
    if (!isWireUnits(amountUnits) || !isWireUnits(priceSats)) return null;
    const product = mulDigitStrings(String(amountUnits), String(priceSats));
    if (product === '0') return 0;
    if (product.length <= 8 || !/^0{8}$/.test(product.slice(-8))) return null;
    const quotient = Number(product.slice(0, -8));
    return Number.isSafeInteger(quotient) ? quotient : null;
};
