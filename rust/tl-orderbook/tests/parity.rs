//! Legacy parity: the committed `parity_cases.txt` are run through the Rust
//! book with every swap settling immediately, and the rendered trace is
//! compared byte-for-byte with `parity_expected.txt`, which
//! `scripts/compare-legacy.cjs` produced by running the legacy compiled
//! matcher (`orderbook.class.js`) on the same cases.
//!
//! Scope: the "safe domain" (amounts multiples of 0.001, prices multiples of
//! 0.01, no dust, no limits hit). Limits are set so that the repaired-defect
//! behaviours (minimum size, depth caps) cannot trigger.

use std::collections::BTreeMap;

use tl_orderbook::*;

const CASES: &str = include_str!("fixtures/parity_cases.txt");
const EXPECTED: &str = include_str!("fixtures/parity_expected.txt");

struct Case {
    name: String,
    key: MarketKey,
    rest: Vec<(Order, bool)>,
    take: (Order, bool),
}

fn kv(parts: &[&str]) -> BTreeMap<String, String> {
    parts
        .iter()
        .map(|p| {
            let (k, v) = p.split_once('=').expect("key=value");
            (k.to_string(), v.to_string())
        })
        .collect()
}

fn order_from(m: &BTreeMap<String, String>, locked: bool) -> Order {
    let get = |k: &str| m.get(k).unwrap_or_else(|| panic!("missing {k}"));
    let props = if m.contains_key("desired") {
        Props::Spot(SpotProps {
            id_desired: get("desired").parse().unwrap(),
            id_for_sale: get("sale").parse().unwrap(),
            amount: Amount::parse(get("amount")).unwrap(),
            price: Price::parse(get("price")).unwrap(),
        })
    } else {
        Props::Futures(FuturesProps {
            contract_id: get("contract").parse().unwrap(),
            amount: Amount::parse(get("amount")).unwrap(),
            price: Price::parse(get("price")).unwrap(),
            leverage: Amount::parse(get("lev")).unwrap(),
            collateral: get("coll").parse().unwrap(),
        })
    };
    Order {
        id: OrderId(get("id").parse().unwrap()),
        session: SessionId(get("sock").parse().unwrap()),
        keypair: Keypair {
            address: get("addr").clone(),
            pubkey: format!("pk{}", get("sock")),
        },
        action: Action::from_wire(get("act")).unwrap(),
        market_name: "m".into(),
        timestamp: 0,
        props,
        state: if locked {
            OrderState::LockedInSwap
        } else {
            OrderState::New
        },
    }
}

fn parse_cases(text: &str) -> Vec<Case> {
    let mut cases = Vec::new();
    let mut name = String::new();
    let mut key = None;
    let mut rest = Vec::new();
    let mut take = None;
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts[0] {
            "case" => {
                name = parts[1].to_string();
                rest = Vec::new();
                take = None;
            }
            "market" => {
                key = Some(if parts[1] == "spot" {
                    MarketKey::Spot {
                        id_desired: parts[2].parse().unwrap(),
                        id_for_sale: parts[3].parse().unwrap(),
                    }
                } else {
                    MarketKey::Futures {
                        contract_id: parts[2].parse().unwrap(),
                    }
                })
            }
            "rest" | "take" => {
                let m = kv(&parts[1..]);
                let locked = m.get("lock").map(|v| v == "1").unwrap_or(false);
                let no_trades = m.get("notrades").map(|v| v == "1").unwrap_or(false);
                let mut o = order_from(&m, locked);
                if parts[0] == "rest" {
                    // resting orders are Open (or LockedInSwap)
                    if o.state == OrderState::New {
                        o.state = OrderState::Open;
                    }
                    rest.push((o, no_trades));
                } else {
                    take = Some((o, no_trades));
                }
            }
            "end" => cases.push(Case {
                name: name.clone(),
                key: key.unwrap(),
                rest: std::mem::take(&mut rest),
                take: take.take().unwrap(),
            }),
            other => panic!("unknown fixture line {other}"),
        }
    }
    cases
}

fn trade_line(req: &SwapRequest) -> String {
    let i = &req.info;
    let mut l = format!(
        "trade type={} buyer={}/{} seller={}/{} taker={} maker={}",
        i.kind.wire(),
        i.buyer.session,
        i.buyer.keypair.address,
        i.seller.session,
        i.seller.keypair.address,
        i.taker,
        i.maker
    );
    match &i.props {
        TradeProps::Spot {
            prop_id_desired,
            prop_id_for_sale,
            amount_desired,
            amount_for_sale,
        } => l.push_str(&format!(
            " desired={prop_id_desired} sale={prop_id_for_sale} amtD={amount_desired} amtS={amount_for_sale}"
        )),
        TradeProps::Futures {
            amount,
            contract_id,
            price,
            leverage,
            collateral,
        } => l.push_str(&format!(
            " contract={contract_id} amount={amount} price={price} lev={leverage} coll={collateral}"
        )),
    }
    match &req.unfilled {
        Some(o) => l.push_str(&format!(" unfilled={}:{}", o.id, o.props.amount())),
        None => l.push_str(" unfilled=none"),
    }
    l
}

fn run_case(c: &Case) -> String {
    // min_amount of one raw unit reproduces the legacy "no dust rule" behaviour.
    let limits = Limits {
        min_amount: Amount::from_raw(1).unwrap(),
        ..Limits::default()
    };
    let rest: Vec<Order> = c.rest.iter().map(|(o, _)| o.clone()).collect();
    let mut book = Orderbook::with_orders(c.key, limits, rest).expect("fixture book");
    let mut out = vec![format!("case {}", c.name)];
    let mut cur = c.take.0.clone();
    let no_trades = c.take.1;
    let mut final_line = "final ok".to_string();
    let mut trade_no = 1u64;
    let mut first = true;
    loop {
        let nt = no_trades && first;
        first = false;
        match book.submit(cur, nt, TradeId(trade_no), 0) {
            Err(e) => {
                final_line = format!("final error={e}");
                break;
            }
            Ok(SubmitOutcome::Placed(_)) => break,
            Ok(SubmitOutcome::Skipped) => {
                final_line = "final skipped".into();
                break;
            }
            Ok(SubmitOutcome::Matched(req)) => {
                out.push(trade_line(&req));
                let done = book
                    .complete(req.trade_id, "tx".into(), 0)
                    .expect("complete");
                trade_no += 1;
                match done.resubmit {
                    Some(o) => cur = o,
                    None => break,
                }
            }
        }
    }
    out.push(final_line);
    for o in book.orders() {
        out.push(format!(
            "book {} {} price={} amount={} lock={}",
            o.id,
            o.action.wire(),
            o.props.price(),
            o.props.amount(),
            u8::from(o.is_locked())
        ));
    }
    out.push("end".into());
    out.join("\n")
}

#[test]
fn rust_matches_legacy_trace_on_all_fixture_cases() {
    let cases = parse_cases(&CASES.replace("\r\n", "\n"));
    assert!(cases.len() >= 300, "fixtures missing");
    let got = cases.iter().map(run_case).collect::<Vec<_>>().join("\n") + "\n";
    let want = EXPECTED.replace("\r\n", "\n");
    if got != want {
        // report the first differing case
        let g: Vec<&str> = got.split("\nend\n").collect();
        let w: Vec<&str> = want.split("\nend\n").collect();
        for (a, b) in g.iter().zip(w.iter()) {
            assert_eq!(a, b, "first differing case");
        }
        panic!("length differs: {} vs {}", g.len(), w.len());
    }
}

#[test]
fn fixtures_exercise_the_interesting_paths() {
    let want = EXPECTED;
    for needle in [
        "final error=Match of the order from the same Account",
        "final error=Match of the order from the same address",
        "final skipped",
        "type=FUTURES",
        "unfilled=none",
    ] {
        assert!(want.contains(needle), "{needle}");
    }
    assert!(want.matches("\ntrade ").count() >= 80);
}
