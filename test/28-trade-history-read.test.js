'use strict';

/*
 * Trade history is read from the end of a market's log files. A read (the no-book path of
 * update-orderbook, and a book's start-up) returns the newest 2000 valid trades of the market and
 * costs the bytes of those records, not the size of the log, which is kept forever.
 */

const fs = require('fs');
const path = require('path');
const moment = require('moment');
const { assert, BUILD } = require('./common');
const { readTradeHistory } = require(path.join(BUILD, 'services/orderbook/orderbook.class'));

const logsDir = path.join(process.cwd(), 'logs');
const TODAY = moment().format('DD-MM-YYYY');
const YESTERDAY = moment().subtract(1, 'days').format('DD-MM-YYYY');
const LIMIT = 2000;

const trade = (time, pubkey = 'buyer-pk') => ({
    type: 'SPOT',
    buyer: { socketId: 'b', keypair: { address: 'buyer-addr', pubkey } },
    seller: { socketId: 's', keypair: { address: 'seller-addr', pubkey: 'seller-pk' } },
    taker: 'b',
    maker: 's',
    props: { propIdDesired: 1, propIdForSale: 2, amountDesired: 100000000, amountForSale: 30000000, price: 30000000 },
    txid: time.toString(16).padStart(64, '0'),
    time,
});
const writeLog = (name, records) => fs.writeFileSync(path.join(logsDir, name), records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)) + '\n').join(''));

// Bytes the reader takes from the logs directory, through either read API.
let bytesRead = 0;
const realReadSync = fs.readSync;
fs.readSync = function (...args) {
    const n = realReadSync.apply(fs, args);
    bytesRead += n;
    return n;
};
const realReadFileSync = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
    const out = realReadFileSync.call(fs, p, ...rest);
    if (String(p).startsWith(logsDir)) bytesRead += Buffer.byteLength(out);
    return out;
};

const times = (trades) => trades.map((t) => t.time);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// ---- a) a large log: the newest 2000 come back, and the read is bounded by them ----------------
{
    const N = 40000;
    // Yesterday's file is older than all of today's, so it never needs reading for today's 2000.
    writeLog(`TRADE-spot_1_2-${YESTERDAY}.log`, range(1, 5000).map((t) => trade(t)));
    const today = range(5001, 5000 + N).map((t) => trade(t));
    // A torn line inside the newest 2000, and a record that spans the chunk boundaries of the reader.
    today[N - 10] = '{"type":"SPOT","buyer":{"socketId":';
    today[N - 20] = trade(5000 + N - 19, 'p'.repeat(150000));
    // A pre-v2 record (float amounts) that is newer than everything: it must not be served.
    today.push({ ...trade(5000 + N + 1), props: { propIdDesired: 1, propIdForSale: 2, amountDesired: 0.5, amountForSale: 0.3, price: 0.3 } });
    writeLog(`TRADE-spot_1_2-${TODAY}.log`, today);
    const logBytes = fs.statSync(path.join(logsDir, `TRADE-spot_1_2-${TODAY}.log`)).size;

    bytesRead = 0;
    const history = readTradeHistory(['spot_1_2', 'spot_2_1']);
    assert.strictEqual(history.length, LIMIT, `F4a FAIL: ${history.length} trades returned, expected ${LIMIT}`);
    const validToday = range(5001, 5000 + N).filter((t) => t !== 5000 + N - 9); // minus the torn line
    assert.deepStrictEqual(times(history), validToday.slice(-LIMIT).reverse(),
        'F4a FAIL: the trades returned are not the newest valid ones, newest first');
    const long = history.find((t) => t.time === 5000 + N - 19);
    assert.ok(long && long.buyer.keypair.pubkey.length === 150000, 'F4a FAIL: a record spanning reads was not returned whole');
    assert.ok(!history.some((t) => t.props.amountDesired === 0.5), 'F4a FAIL: a pre-v2 record was served');
    assert.ok(bytesRead < 1024 * 1024 && bytesRead < logBytes / 4,
        `F4a FAIL: a read of the newest ${LIMIT} trades took ${bytesRead} bytes (today's log is ${logBytes})`);
    console.log(`F4a PASS: newest ${LIMIT} valid trades returned from a ${logBytes}-byte log, reading ${bytesRead} bytes`);
}

// ---- b) the newest trades span two days: the older day supplies only what is still missing ----
{
    writeLog(`TRADE-spot_3_4-${YESTERDAY}.log`, range(1, 3000).map((t) => trade(t)));
    writeLog(`TRADE-spot_3_4-${TODAY}.log`, range(3001, 3500).map((t) => trade(t)));
    const history = readTradeHistory(['spot_3_4']);
    assert.deepStrictEqual(times(history), range(1501, 3500).reverse(),
        'F4b FAIL: trades across two days are not the newest 2000 of both');
    console.log('F4b PASS: a market read across two days returns the newest 2000 of both, newest first');
}

process.exit(0);
