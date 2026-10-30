//! Throughput bench of the Rust book on a workload from `scripts/gen-workload.cjs`.
//!
//!   cargo run --release --example throughput -- <workload.tsv> <trace-out.txt>
//!
//! Drives one spot `Orderbook` exactly as `tests/parity.rs` does (every swap settles at once and
//! the taker remainder is resubmitted), with limits opened up so nothing the legacy server lacks
//! (session caps, depth caps, dust floor) changes the outcome. Prints one JSON line with orders,
//! trades, errors, wall time, orders/s, per-order latency percentiles (µs, including the order's
//! fills) and peak RSS, and writes the trade trace + final book in the format of
//! `scripts/bench-legacy.cjs`, so the two traces must be byte-identical.
use std::fs;
use std::io::Write;
use std::time::Instant;
use tl_orderbook::*;

fn order(line: &str) -> Order {
    let f: Vec<&str> = line.split('\t').collect();
    assert_eq!(f.len(), 8, "bad workload line: {line}");
    Order {
        id: OrderId(f[0].parse().unwrap()),
        session: SessionId(f[1].parse().unwrap()),
        keypair: Keypair {
            address: f[2].to_string(),
            pubkey: format!("pk{}", f[1]),
        },
        action: Action::from_wire(f[3]).unwrap(),
        market_name: "m".into(),
        timestamp: 0,
        props: Props::Spot(SpotProps {
            id_desired: f[4].parse().unwrap(),
            id_for_sale: f[5].parse().unwrap(),
            amount: Amount::parse(f[7]).unwrap(),
            price: Price::parse(f[6]).unwrap(),
        }),
        state: OrderState::New,
    }
}

fn vm_hwm_kb() -> Option<u64> {
    let s = fs::read_to_string("/proc/self/status").ok()?;
    s.lines()
        .find(|l| l.starts_with("VmHWM:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// Submit one order and settle every resulting swap; returns (trades, errored).
fn run_order(
    book: &mut Orderbook,
    first: Order,
    next_trade: &mut u64,
    trace: &mut Vec<String>,
) -> (u64, bool) {
    let mut cur = first;
    let mut trades = 0;
    loop {
        match book.submit(cur, false, TradeId(*next_trade), 0) {
            Err(_) => return (trades, true),
            Ok(SubmitOutcome::Placed(_)) | Ok(SubmitOutcome::Skipped) => return (trades, false),
            Ok(SubmitOutcome::Matched(req)) => {
                if let TradeProps::Spot {
                    amount_desired,
                    amount_for_sale,
                    ..
                } = &req.info.props
                {
                    trace.push(format!(
                        "trade {} {} {} {}",
                        req.info.taker, req.info.maker, amount_desired, amount_for_sale
                    ));
                }
                let done = book
                    .complete(req.trade_id, "tx".into(), 0)
                    .expect("complete");
                *next_trade += 1;
                trades += 1;
                match done.resubmit {
                    Some(o) => cur = o,
                    None => return (trades, false),
                }
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let text = fs::read_to_string(&args[1]).expect("workload");
    let orders: Vec<Order> = text.lines().filter(|l| !l.is_empty()).map(order).collect();
    let limits = Limits {
        min_amount: Amount::from_raw(1).unwrap(),
        max_orders_per_session: usize::MAX / 2,
        max_side_depth: usize::MAX / 2,
        max_pending_swaps: usize::MAX / 2,
        max_swaps_per_session: usize::MAX / 2,
        ..Limits::default()
    };
    let mut book = Orderbook::new(MarketKey::from_props(&orders[0].props), limits);
    let mut trace = Vec::new();
    let mut next_trade = 1u64;
    // The legacy constructor places the first order; do the same outside the timed loop.
    run_order(&mut book, orders[0].clone(), &mut next_trade, &mut trace);
    book.take_events();

    let mut lat = Vec::with_capacity(orders.len());
    let mut trades = 0u64;
    let mut errors = 0u64;
    let t0 = Instant::now();
    for o in &orders[1..] {
        let a = Instant::now();
        let (t, e) = run_order(&mut book, o.clone(), &mut next_trade, &mut trace);
        book.take_events();
        lat.push(a.elapsed().as_nanos() as f64 / 1000.0);
        trades += t;
        errors += u64::from(e);
    }
    let wall = t0.elapsed().as_secs_f64();

    for o in book.orders() {
        trace.push(format!(
            "book {} {} {} {}",
            o.id,
            o.action.wire(),
            o.props.price(),
            o.props.amount()
        ));
    }
    let mut f = fs::File::create(&args[2]).expect("trace");
    f.write_all((trace.join("\n") + "\n").as_bytes())
        .expect("trace write");

    lat.sort_by(|a, b| a.total_cmp(b));
    let pct = |p: f64| lat[((p * lat.len() as f64) as usize).min(lat.len() - 1)];
    println!(
        "{{\"engine\":\"rust\",\"orders\":{},\"trades\":{},\"errors\":{},\"resting\":{},\"wall_ms\":{:.1},\"orders_per_sec\":{},\"p50_us\":{:.1},\"p99_us\":{:.1},\"max_us\":{:.1},\"peak_rss_kb\":{}}}",
        orders.len(),
        trades,
        errors,
        book.order_count(),
        wall * 1000.0,
        ((orders.len() - 1) as f64 / wall).round() as u64,
        pct(0.5),
        pct(0.99),
        lat[lat.len() - 1],
        vm_hwm_kb().map_or("null".into(), |v| v.to_string())
    );
}
