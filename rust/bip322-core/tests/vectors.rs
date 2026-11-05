//! Known-answer tests: the official BIP-322 vectors (bitcoin/bips bip-0322/*.json) plus
//! Bitcoin and Litecoin vectors produced with a synthetic key by the crate's own signer.

use bip322_core::signer::{address_for, sign, AddrType};
use bip322_core::{message_hash, to_sign_skeleton, to_spend_tx, verify, verify_detailed, Network};
use serde_json::Value;

fn load(name: &str) -> Value {
    let p = format!("{}/tests/vectors/{}", env!("CARGO_MANIFEST_DIR"), name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn supported(ty: &str) -> bool {
    matches!(ty, "p2wpkh" | "p2tr" | "p2pkh" | "p2sh-p2wpkh")
}

#[test]
fn spec_message_and_tx_hashes() {
    let v = load("basic-test-vectors.json");
    for t in v["tx_hashes"].as_array().unwrap() {
        let msg = t["message"].as_str().unwrap();
        assert_eq!(hex(&message_hash(msg.as_bytes())), t["message_hash"].as_str().unwrap());
        let addr = bip322_core::decode_address(t["address"].as_str().unwrap(), None).unwrap();
        let spk = addr.script_pubkey();
        let to_spend = to_spend_tx(msg.as_bytes(), &spk);
        assert_eq!(to_spend.compute_txid().to_string(), t["to_spend_tx_hash"].as_str().unwrap());
        let to_sign = to_sign_skeleton(&to_spend);
        assert_eq!(to_sign.compute_txid().to_string(), t["to_sign_tx_hash"].as_str().unwrap());
    }
}

#[test]
fn spec_basic_simple_signatures_verify() {
    let v = load("basic-test-vectors.json");
    let mut n = 0;
    for t in v["simple"].as_array().unwrap() {
        if !supported(t["type"].as_str().unwrap()) {
            continue;
        }
        for s in t["bip322_signatures"].as_array().unwrap() {
            let ok = verify_detailed(t["address"].as_str().unwrap(), t["message"].as_str().unwrap(), s.as_str().unwrap(), "btc");
            assert!(ok.is_ok(), "{:?} {:?}", t["type"], ok);
            n += 1;
        }
    }
    assert_eq!(n, 5); // p2wpkh "" x2, p2wpkh "Hello World" x2, p2tr unprefixed fallback
}

#[test]
fn spec_basic_errors_reject() {
    let v = load("basic-test-vectors.json");
    for t in v["error"].as_array().unwrap() {
        let r = verify_detailed(
            t["address"].as_str().unwrap(),
            t["message"].as_str().unwrap(),
            t["signature"].as_str().unwrap(),
            "btc",
        );
        assert!(r.is_err(), "{} verified", t["description"]);
    }
}

#[test]
fn spec_generated_vectors() {
    let v = load("generated-test-vectors.json");
    let (mut ok, mut unsupported) = (0, 0);
    for kind in ["simple", "full"] {
        for t in v[kind].as_array().unwrap() {
            let ty = t["type"].as_str().unwrap();
            for s in t["bip322_signatures"].as_array().unwrap() {
                let r = verify_detailed(t["address"].as_str().unwrap(), t["message"].as_str().unwrap(), s.as_str().unwrap(), "btc");
                if supported(ty) {
                    assert!(r.is_ok(), "{kind} {ty}: {r:?}");
                    ok += 1;
                } else {
                    assert!(r.is_err(), "{kind} {ty} must be rejected");
                    unsupported += 1;
                }
            }
        }
    }
    assert!(ok >= 6, "verified {ok}");
    assert!(unsupported >= 5, "rejected {unsupported}");
    for t in v["error"].as_array().unwrap() {
        // the vector carries address + message + signature; none may verify
        let r = verify(
            t["address"].as_str().unwrap(),
            t["message"].as_str().unwrap(),
            t["signature"].as_str().unwrap(),
            "btc",
        );
        assert!(!r, "{} verified", t["description"]);
    }
}

#[test]
fn spec_vector_network_mismatch_rejected() {
    let v = load("basic-test-vectors.json");
    let t = &v["simple"][0];
    let (a, m, s) = (t["address"].as_str().unwrap(), t["message"].as_str().unwrap(), t["bip322_signatures"][0].as_str().unwrap());
    assert!(verify(a, m, s, "btc"));
    assert!(verify(a, m, s, "auto"));
    assert!(verify(a, m, s, ""));
    assert!(!verify(a, m, s, "tbtc"));
    assert!(!verify(a, m, s, "ltc"));
    assert!(!verify(a, m, s, "no-such-network"));
}

const SK: [u8; 32] = [
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x01,
    0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe, 0x21,
];
const SK2: [u8; 32] = [7u8; 32];

const NETS: [&str; 6] = ["btc", "tbtc", "rbtc", "ltc", "tltc", "rltc"];
const TYPES: [AddrType; 4] = [AddrType::P2pkh, AddrType::P2shP2wpkh, AddrType::P2wpkh, AddrType::P2tr];

#[test]
fn signer_roundtrip_every_chain_and_type() {
    for net in NETS {
        let network = Network::parse(net).unwrap().unwrap();
        for ty in TYPES {
            for msg in ["", "Hello World", "TradeLayer session authentication\nnonce=00ff\nexpires=1"] {
                let s = sign(SK, ty, network, msg).unwrap();
                let r = verify_detailed(&s.address, msg, &s.signature, net);
                assert!(r.is_ok(), "{net} {ty:?} {msg:?} {} {r:?}", s.address);
                assert!(verify(&s.address, msg, &s.signature, "auto"), "{net} {ty:?} auto");
                // wrong message, wrong key, wrong network
                assert!(!verify(&s.address, "other", &s.signature, net), "{net} {ty:?} wrong message");
                let other = sign(SK2, ty, network, msg).unwrap();
                assert!(!verify(&s.address, msg, &other.signature, net), "{net} {ty:?} wrong signer");
                assert!(!verify(&other.address, msg, &s.signature, net), "{net} {ty:?} wrong address");
                let wrong_net = if net.contains("ltc") { "btc" } else { "ltc" };
                assert!(!verify(&s.address, msg, &s.signature, wrong_net), "{net} {ty:?} network label");
            }
        }
    }
}

#[test]
fn litecoin_address_encodings() {
    let first = |s: &str| s.chars().next().unwrap();
    let ltc = Network::parse("ltc").unwrap().unwrap();
    assert_eq!(first(&address_for(SK, AddrType::P2pkh, ltc).unwrap()), 'L');
    assert_eq!(first(&address_for(SK, AddrType::P2shP2wpkh, ltc).unwrap()), 'M');
    assert!(address_for(SK, AddrType::P2wpkh, ltc).unwrap().starts_with("ltc1q"));
    assert!(address_for(SK, AddrType::P2tr, ltc).unwrap().starts_with("ltc1p"));
    let tltc = Network::parse("tltc").unwrap().unwrap();
    assert!(matches!(first(&address_for(SK, AddrType::P2pkh, tltc).unwrap()), 'm' | 'n'));
    assert_eq!(first(&address_for(SK, AddrType::P2shP2wpkh, tltc).unwrap()), '2');
    assert!(address_for(SK, AddrType::P2wpkh, tltc).unwrap().starts_with("tltc1q"));
    let rltc = Network::parse("rltc").unwrap().unwrap();
    assert!(address_for(SK, AddrType::P2tr, rltc).unwrap().starts_with("rltc1p"));
    let bc = Network::parse("btc").unwrap().unwrap();
    assert!(address_for(SK, AddrType::P2wpkh, bc).unwrap().starts_with("bc1q"));
    let rbtc = Network::parse("rbtc").unwrap().unwrap();
    assert!(address_for(SK, AddrType::P2wpkh, rbtc).unwrap().starts_with("bcrt1q"));
}

#[test]
fn litecoin_and_bitcoin_messages_do_not_cross_verify_for_p2pkh() {
    // BIP-137 hashes a chain specific magic, so a Bitcoin signature of a P2PKH key does not
    // verify for the same key's Litecoin address, and vice versa.
    let btc = Network::parse("btc").unwrap().unwrap();
    let ltc = Network::parse("ltc").unwrap().unwrap();
    let s_btc = sign(SK, AddrType::P2pkh, btc, "m").unwrap();
    let ltc_addr = address_for(SK, AddrType::P2pkh, ltc).unwrap();
    assert!(!verify(&ltc_addr, "m", &s_btc.signature, "ltc"));
    let s_ltc = sign(SK, AddrType::P2pkh, ltc, "m").unwrap();
    assert!(verify(&ltc_addr, "m", &s_ltc.signature, "ltc"));
}

#[test]
fn malformed_input_is_false_not_a_panic() {
    let btc = Network::parse("btc").unwrap().unwrap();
    let s = sign(SK, AddrType::P2wpkh, btc, "x").unwrap();
    for sig in ["", "smp", "smp!!", "ful", "ful AA", "pofAA==", "AA==", "smpAA==", "smpAQA=", "////"] {
        assert!(!verify(&s.address, "x", sig, "btc"), "{sig}");
    }
    for addr in ["", "bc1", "notanaddress", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"] {
        assert!(!verify(addr, "x", &s.signature, "btc"), "{addr}");
    }
    let huge = "A".repeat(100_000);
    assert!(!verify(&s.address, "x", &huge, "btc"));
    assert!(!verify(&s.address, &huge, &s.signature, "btc"));
}

#[test]
fn flipped_signature_bits_are_rejected() {
    use base64::Engine as _;
    let btc = Network::parse("btc").unwrap().unwrap();
    for ty in TYPES {
        let s = sign(SK, ty, btc, "flip").unwrap();
        let (prefix, body) = match s.signature.strip_prefix("smp") {
            Some(b) => ("smp", b.to_string()),
            None => ("", s.signature.clone()),
        };
        let raw = base64::engine::general_purpose::STANDARD.decode(&body).unwrap();
        for i in (0..raw.len()).step_by(7) {
            let mut bad = raw.clone();
            bad[i] ^= 0x40;
            let sig = format!("{prefix}{}", base64::engine::general_purpose::STANDARD.encode(&bad));
            assert!(!verify(&s.address, "flip", &sig, "btc"), "{ty:?} byte {i}");
        }
    }
}
