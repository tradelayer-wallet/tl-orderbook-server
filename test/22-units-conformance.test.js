'use strict';

// The shared units rules (protocol-v2.md B.2) against the conformance vectors that the wallet
// repo also runs. The file's SHA-256 is pinned here; the wallet's test pins the same value, so an
// edit to one copy fails that repo's test until the other copy is changed too.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { BUILD } = require('./common');

const VECTORS = path.join(__dirname, 'conformance', 'units-conformance.json');
const EXPECTED_SHA256 = 'c68d619fd9a05e837a77092cdd808eb3ed1ea52e26b71449a6043f22ab71393c';

const { isWireUnits, valueSats } = require(path.join(BUILD, 'utils/pure/units'));

const raw = fs.readFileSync(VECTORS);
assert.strictEqual(crypto.createHash('sha256').update(raw).digest('hex'), EXPECTED_SHA256,
    'units-conformance.json differs from the copy pinned for this round: update both repos together');

const vectors = JSON.parse(raw.toString('utf8'));
let checks = 0;
for (const v of vectors.isWireUnits) {
    assert.strictEqual(isWireUnits(v.input), v.expect, `isWireUnits(${JSON.stringify(v.input)})`);
    checks++;
}
for (const v of vectors.valueSats) {
    assert.strictEqual(valueSats(v.amountUnits, v.priceSats), v.expect,
        `valueSats(${v.amountUnits}, ${v.priceSats})`);
    checks++;
}
console.log(`UNITS CONFORMANCE PASS: ${checks} vectors, file sha256 pinned`);
process.exit(0);
