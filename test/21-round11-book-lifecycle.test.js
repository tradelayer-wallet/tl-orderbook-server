'use strict';

/*
 * Round 11 regressions: log durability and orderbook lifecycle.
 *
 * R11-2: saveLog returns only once its record is on disk. It appended asynchronously, so a
 * read-modify-write that followed it (updateOrderLog, the CANCALED/FILLED audit update) could
 * run before the record existed and leave it without its final state.
 */
const fs = require('fs');
const path = require('path');
const { assert, sleep, BUILD, workDir } = require('./common');

const mixPure = require(path.join(BUILD, 'utils/pure/mix.pure'));

(async () => {
    try {
        const uuid = 'r11-2-order';
        mixPure.saveLog('spot_9_8', 'ORDER', { uuid, socket_id: 's', timestamp: 1, props: {} });
        mixPure.updateOrderLog(['spot_9_8'], uuid, 'CANCALED');
        await sleep(200);

        const file = fs.readdirSync(path.join(workDir, 'logs')).find((f) => f.startsWith('ORDER-spot_9_8-'));
        assert.ok(file, 'R11-2 FAIL: order log file missing');
        const records = fs.readFileSync(path.join(workDir, 'logs', file), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l));
        assert.strictEqual(records.length, 1, 'R11-2 FAIL: record not written exactly once');
        assert.strictEqual(records[0].state, 'CANCALED', 'R11-2 FAIL: audit state lost to a write that raced the append');
        console.log('R11-2 PASS: a logged record is on disk before the next audit update');
        process.exit(0);
    } catch (e) {
        console.error('R11-2 FAIL:', e && e.stack || e);
        process.exit(1);
    }
})();
