// adjust the relative path to wherever the .node file landed
const core = require('./rust/matcher-core/matcher_core.node');

// create a book once
core.createBook('BTCUSD');

// place an order
const res = core.submit('BTCUSD', {
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6', // UUID or 26-char ULID
  side: 'BUY',      // 'BUY' | 'SELL'
  price: 65000,     // becomes u64 (floor); add scaling if you need decimals
  amount: 1,        // becomes u64 (floor)
  socket_id: 'sockA'
});
console.log('submit:', res);

// snapshot / stats
console.log('snapshot:', core.snapshot('BTCUSD', 10));
console.log('stats:', core.stats('BTCUSD'));
