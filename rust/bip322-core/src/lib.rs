//! BIP-322 and BIP-137 signed-message verification for single-key addresses.
//!
//! Chains: Bitcoin (bc / tb / bcrt, base58 0x00 0x05 0x6f 0xc4) and Litecoin
//! (ltc / tltc / rltc, base58 L M m n 2). The address is decoded here, not by
//! `bitcoin::Address`, because that type rejects Litecoin encodings.
//!
//! Accepted signatures
//! * `smp` + base64(witness stack), "simple": P2WPKH, P2SH-P2WPKH (the scriptSig is
//!   rebuilt from the witness public key), P2TR key path.
//! * `ful` + base64(to_sign transaction), "full", without extra inputs: P2WPKH,
//!   P2SH-P2WPKH, P2TR key path, P2PKH.
//! * no prefix: simple (pre-final BIP-322 form), or for P2PKH a 65 byte BIP-137
//!   compact recoverable signature (headers 27..=34).
//!
//! Everything else (P2WSH, script-path taproot, multisig, proof of funds) is rejected.

use base64::{
    alphabet,
    engine::{general_purpose::GeneralPurpose, DecodePaddingMode, GeneralPurposeConfig},
    Engine as _,
};
use bitcoin::{
    absolute::LockTime,
    base58,
    bech32,
    consensus::{deserialize, encode::serialize},
    hashes::{hash160, sha256, sha256d, Hash, HashEngine},
    opcodes::all::{OP_PUSHBYTES_0, OP_RETURN},
    script::{Builder, Instruction, PushBytesBuf},
    secp256k1::{
        ecdsa::{RecoverableSignature, RecoveryId},
        Message, Secp256k1, VerifyOnly, XOnlyPublicKey,
    },
    sighash::{EcdsaSighashType, Prevouts, SighashCache, TapSighashType},
    transaction::Version,
    Amount, CompressedPublicKey, OutPoint, Script, ScriptBuf, Sequence, Transaction, TxIn, TxOut,
    Witness,
};
use std::sync::OnceLock;

pub mod signer;

const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_SIGNATURE_CHARS: usize = 16 * 1024;
const MAX_ADDRESS_CHARS: usize = 120;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Chain {
    Btc,
    Ltc,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Net {
    Main,
    Test,
    Reg,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Network {
    pub chain: Chain,
    pub net: Net,
}

impl Network {
    /// Parses a network label. Ok(None) for "" / "auto": infer the network from the address.
    pub fn parse(label: &str) -> Result<Option<Network>, String> {
        use Chain::*;
        use Net::*;
        let n = |chain, net| Ok(Some(Network { chain, net }));
        match label.trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Ok(None),
            "btc" | "bitcoin" | "main" | "mainnet" | "btcmain" => n(Btc, Main),
            "btctest" | "tbtc" | "testnet" | "testnet3" | "testnet4" | "signet" | "btctestnet" => {
                n(Btc, Test)
            }
            "btcregtest" | "rbtc" | "regtest" => n(Btc, Reg),
            "ltc" | "litecoin" | "ltcmain" => n(Ltc, Main),
            "ltctest" | "tltc" | "ltctestnet" => n(Ltc, Test),
            "ltcregtest" | "rltc" => n(Ltc, Reg),
            other => Err(format!("unknown network '{other}'")),
        }
    }

    fn message_magic(&self) -> &'static [u8] {
        match self.chain {
            Chain::Btc => b"\x18Bitcoin Signed Message:\n",
            Chain::Ltc => b"\x19Litecoin Signed Message:\n",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    P2pkh([u8; 20]),
    P2sh([u8; 20]),
    P2wpkh([u8; 20]),
    P2wsh([u8; 32]),
    P2tr([u8; 32]),
}

#[derive(Clone, Copy, Debug)]
pub struct Addr {
    pub network: Network,
    /// base58 test addresses carry the same version byte on testnet and regtest.
    pub test_or_reg: bool,
    pub kind: Kind,
}

pub(crate) fn push(b: Builder, data: &[u8]) -> Builder {
    b.push_slice(PushBytesBuf::try_from(data.to_vec()).expect("short push"))
}

impl Addr {
    pub fn script_pubkey(&self) -> ScriptBuf {
        use bitcoin::opcodes::all::*;
        match self.kind {
            Kind::P2pkh(h) => push(Builder::new().push_opcode(OP_DUP).push_opcode(OP_HASH160), &h)
                .push_opcode(OP_EQUALVERIFY)
                .push_opcode(OP_CHECKSIG)
                .into_script(),
            Kind::P2sh(h) => push(Builder::new().push_opcode(OP_HASH160), &h)
                .push_opcode(OP_EQUAL)
                .into_script(),
            Kind::P2wpkh(h) => push(Builder::new().push_int(0), &h).into_script(),
            Kind::P2wsh(h) => push(Builder::new().push_int(0), &h).into_script(),
            Kind::P2tr(x) => push(Builder::new().push_int(1), &x).into_script(),
        }
    }

    pub fn matches(&self, want: Network) -> bool {
        if self.network.chain != want.chain {
            return false;
        }
        if self.network.net == want.net {
            return true;
        }
        self.test_or_reg && matches!(want.net, Net::Test | Net::Reg)
    }
}

fn hrp_network(hrp: &str) -> Option<Network> {
    let (chain, net) = match hrp {
        "bc" => (Chain::Btc, Net::Main),
        "tb" => (Chain::Btc, Net::Test),
        "bcrt" => (Chain::Btc, Net::Reg),
        "ltc" => (Chain::Ltc, Net::Main),
        "tltc" => (Chain::Ltc, Net::Test),
        "rltc" => (Chain::Ltc, Net::Reg),
        _ => return None,
    };
    Some(Network { chain, net })
}

pub fn hrp_for(network: Network) -> &'static str {
    match (network.chain, network.net) {
        (Chain::Btc, Net::Main) => "bc",
        (Chain::Btc, Net::Test) => "tb",
        (Chain::Btc, Net::Reg) => "bcrt",
        (Chain::Ltc, Net::Main) => "ltc",
        (Chain::Ltc, Net::Test) => "tltc",
        (Chain::Ltc, Net::Reg) => "rltc",
    }
}

/// (P2PKH version, P2SH version) used when this crate encodes an address.
pub fn base58_versions(network: Network) -> (u8, u8) {
    match (network.chain, network.net) {
        (Chain::Btc, Net::Main) => (0x00, 0x05),
        (Chain::Ltc, Net::Main) => (0x30, 0x32),
        _ => (0x6f, 0xc4),
    }
}

fn base58_kind(version: u8, h: [u8; 20]) -> Option<(Network, bool, Kind)> {
    let mk = |chain, net, tr, kind| Some((Network { chain, net }, tr, kind));
    match version {
        0x00 => mk(Chain::Btc, Net::Main, false, Kind::P2pkh(h)),
        0x05 => mk(Chain::Btc, Net::Main, false, Kind::P2sh(h)),
        0x30 => mk(Chain::Ltc, Net::Main, false, Kind::P2pkh(h)),
        0x32 => mk(Chain::Ltc, Net::Main, false, Kind::P2sh(h)),
        // 0x6f / 0xc4 / 0x3a are shared by the Bitcoin and Litecoin test chains: the caller's
        // network label picks the chain (tagged Btc here, re-tagged in decode_address).
        0x6f => mk(Chain::Btc, Net::Test, true, Kind::P2pkh(h)),
        0xc4 | 0x3a => mk(Chain::Btc, Net::Test, true, Kind::P2sh(h)),
        _ => None,
    }
}

pub fn decode_address(address: &str, want: Option<Network>) -> Result<Addr, String> {
    let address = address.trim();
    if address.is_empty() || address.len() > MAX_ADDRESS_CHARS {
        return Err("bad address length".into());
    }
    if let Ok((hrp, version, program)) = bech32::segwit::decode(address) {
        let network = hrp_network(&hrp.to_lowercase()).ok_or("unknown bech32 hrp")?;
        let kind = match (version.to_u8(), program.len()) {
            (0, 20) => Kind::P2wpkh(program.try_into().unwrap()),
            (0, 32) => Kind::P2wsh(program.try_into().unwrap()),
            (1, 32) => Kind::P2tr(program.try_into().unwrap()),
            _ => return Err("unsupported witness program".into()),
        };
        return Ok(Addr { network, test_or_reg: false, kind });
    }
    let raw = base58::decode_check(address).map_err(|_| "undecodable address")?;
    if raw.len() != 21 {
        return Err("bad base58 payload".into());
    }
    let mut h = [0u8; 20];
    h.copy_from_slice(&raw[1..]);
    let (mut network, test_or_reg, kind) =
        base58_kind(raw[0], h).ok_or("unknown base58 version")?;
    if test_or_reg {
        if let Some(w) = want {
            network.chain = w.chain;
        }
    }
    Ok(Addr { network, test_or_reg, kind })
}

fn secp() -> &'static Secp256k1<VerifyOnly> {
    static CTX: OnceLock<Secp256k1<VerifyOnly>> = OnceLock::new();
    CTX.get_or_init(Secp256k1::verification_only)
}

fn b64() -> GeneralPurpose {
    GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    )
}

/// BIP-340 tagged hash "BIP0322-signed-message" of the message bytes.
pub fn message_hash(message: &[u8]) -> [u8; 32] {
    let tag = sha256::Hash::hash(b"BIP0322-signed-message");
    let mut eng = sha256::Hash::engine();
    eng.input(tag.as_byte_array());
    eng.input(tag.as_byte_array());
    eng.input(message);
    sha256::Hash::from_engine(eng).to_byte_array()
}

pub fn to_spend_tx(message: &[u8], spk: &Script) -> Transaction {
    let script_sig = push(Builder::new().push_opcode(OP_PUSHBYTES_0), &message_hash(message)).into_script();
    Transaction {
        version: Version(0),
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint { txid: bitcoin::Txid::all_zeros(), vout: 0xFFFF_FFFF },
            script_sig,
            sequence: Sequence::ZERO,
            witness: Witness::new(),
        }],
        output: vec![TxOut { value: Amount::ZERO, script_pubkey: spk.to_owned() }],
    }
}

pub fn to_sign_skeleton(to_spend: &Transaction) -> Transaction {
    Transaction {
        version: Version(0),
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint { txid: to_spend.compute_txid(), vout: 0 },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ZERO,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::ZERO,
            script_pubkey: Builder::new().push_opcode(OP_RETURN).into_script(),
        }],
    }
}

fn pushes(script: &Script) -> Option<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    for ins in script.instructions() {
        match ins.ok()? {
            Instruction::PushBytes(b) => out.push(b.as_bytes().to_vec()),
            Instruction::Op(_) => return None,
        }
    }
    Some(out)
}

pub(crate) fn msg_of<H: Hash<Bytes = [u8; 32]>>(h: H) -> Message {
    Message::from_digest(h.to_byte_array())
}

pub(crate) fn h160(data: &[u8]) -> [u8; 20] {
    hash160::Hash::hash(data).to_byte_array()
}

fn verify_ecdsa_der(msg: &Message, sig_bytes: &[u8], pk: &CompressedPublicKey) -> Result<(), String> {
    let sig = bitcoin::ecdsa::Signature::from_slice(sig_bytes).map_err(|_| "bad ecdsa signature")?;
    if sig.sighash_type != EcdsaSighashType::All {
        return Err("sighash type must be ALL".into());
    }
    secp()
        .verify_ecdsa(msg, &sig.signature, &pk.0)
        .map_err(|_| "invalid signature".to_string())
}

/// Validates the single-input `to_sign` transaction for the address kind.
fn check_to_sign(
    addr: &Addr,
    spk: &Script,
    to_spend_txid: bitcoin::Txid,
    tx: &Transaction,
) -> Result<(), String> {
    if tx.input.len() != 1 || tx.output.len() != 1 {
        return Err("extra inputs or outputs".into());
    }
    let inp = &tx.input[0];
    if inp.previous_output != (OutPoint { txid: to_spend_txid, vout: 0 }) {
        return Err("to_sign does not spend to_spend".into());
    }
    let out = &tx.output[0];
    if out.value != Amount::ZERO || out.script_pubkey.as_bytes() != [OP_RETURN.to_u8()] {
        return Err("to_sign output is not OP_RETURN with zero value".into());
    }
    let mut cache = SighashCache::new(tx);
    let all = EcdsaSighashType::All;
    match addr.kind {
        Kind::P2wpkh(h) => {
            if !inp.script_sig.is_empty() || inp.witness.len() != 2 {
                return Err("bad p2wpkh witness".into());
            }
            let pk = CompressedPublicKey::from_slice(inp.witness.nth(1).unwrap())
                .map_err(|_| "bad pubkey")?;
            if h160(&pk.to_bytes()) != h {
                return Err("pubkey does not match address".into());
            }
            let hash = cache
                .p2wpkh_signature_hash(0, spk, Amount::ZERO, all)
                .map_err(|e| e.to_string())?;
            verify_ecdsa_der(&msg_of(hash), inp.witness.nth(0).unwrap(), &pk)
        }
        Kind::P2sh(h) => {
            let items = pushes(&inp.script_sig).ok_or("bad p2sh scriptSig")?;
            if items.len() != 1 {
                return Err("bad p2sh scriptSig".into());
            }
            let redeem = ScriptBuf::from_bytes(items[0].clone());
            if h160(redeem.as_bytes()) != h {
                return Err("redeem script does not match address".into());
            }
            if !redeem.is_p2wpkh() || inp.witness.len() != 2 {
                return Err("only P2SH-P2WPKH is supported".into());
            }
            let pk = CompressedPublicKey::from_slice(inp.witness.nth(1).unwrap())
                .map_err(|_| "bad pubkey")?;
            if h160(&pk.to_bytes()) != redeem.as_bytes()[2..22] {
                return Err("pubkey does not match redeem script".into());
            }
            let hash = cache
                .p2wpkh_signature_hash(0, &redeem, Amount::ZERO, all)
                .map_err(|e| e.to_string())?;
            verify_ecdsa_der(&msg_of(hash), inp.witness.nth(0).unwrap(), &pk)
        }
        Kind::P2tr(x) => {
            if !inp.script_sig.is_empty() || inp.witness.len() != 1 {
                return Err("only taproot key path is supported".into());
            }
            let sig = bitcoin::taproot::Signature::from_slice(inp.witness.nth(0).unwrap())
                .map_err(|_| "bad schnorr signature")?;
            if !matches!(sig.sighash_type, TapSighashType::Default | TapSighashType::All) {
                return Err("sighash type must be DEFAULT or ALL".into());
            }
            let xonly = XOnlyPublicKey::from_slice(&x).map_err(|_| "bad output key")?;
            let prevout = TxOut { value: Amount::ZERO, script_pubkey: spk.to_owned() };
            let hash = cache
                .taproot_key_spend_signature_hash(0, &Prevouts::All(&[prevout]), sig.sighash_type)
                .map_err(|e| e.to_string())?;
            secp()
                .verify_schnorr(&sig.signature, &msg_of(hash), &xonly)
                .map_err(|_| "invalid signature".to_string())
        }
        Kind::P2pkh(h) => {
            if !inp.witness.is_empty() {
                return Err("p2pkh must not carry a witness".into());
            }
            let items = pushes(&inp.script_sig).ok_or("bad p2pkh scriptSig")?;
            if items.len() != 2 {
                return Err("bad p2pkh scriptSig".into());
            }
            let pk = bitcoin::PublicKey::from_slice(&items[1]).map_err(|_| "bad pubkey")?;
            if h160(&pk.to_bytes()) != h {
                return Err("pubkey does not match address".into());
            }
            let sig = bitcoin::ecdsa::Signature::from_slice(&items[0]).map_err(|_| "bad ecdsa signature")?;
            if sig.sighash_type != all {
                return Err("sighash type must be ALL".into());
            }
            let hash = cache
                .legacy_signature_hash(0, spk, all.to_u32())
                .map_err(|e| e.to_string())?;
            secp()
                .verify_ecdsa(&msg_of(hash), &sig.signature, &pk.inner)
                .map_err(|_| "invalid signature".to_string())
        }
        Kind::P2wsh(_) => Err("p2wsh is not supported".into()),
    }
}

fn verify_simple(addr: &Addr, message: &[u8], witness_bytes: &[u8]) -> Result<(), String> {
    let witness: Witness = deserialize(witness_bytes).map_err(|_| "bad witness encoding")?;
    let spk = addr.script_pubkey();
    let to_spend = to_spend_tx(message, &spk);
    let mut to_sign = to_sign_skeleton(&to_spend);
    match addr.kind {
        Kind::P2wpkh(_) | Kind::P2tr(_) => {}
        Kind::P2sh(_) => {
            // The simple form carries no scriptSig: it is the push of the P2WPKH redeem script.
            let pk = witness.nth(1).ok_or("bad p2sh-p2wpkh witness")?;
            let pk = CompressedPublicKey::from_slice(pk).map_err(|_| "bad pubkey")?;
            let redeem = push(Builder::new().push_int(0), &h160(&pk.to_bytes())).into_script();
            to_sign.input[0].script_sig = push(Builder::new(), redeem.as_bytes()).into_script();
        }
        _ => return Err("simple signatures need p2wpkh, p2sh-p2wpkh or p2tr".into()),
    }
    to_sign.input[0].witness = witness;
    check_to_sign(addr, &spk, to_spend.compute_txid(), &to_sign)
}

fn verify_full(addr: &Addr, message: &[u8], tx_bytes: &[u8]) -> Result<(), String> {
    let tx: Transaction = deserialize(tx_bytes).map_err(|_| "bad transaction encoding")?;
    let spk = addr.script_pubkey();
    let to_spend = to_spend_tx(message, &spk);
    check_to_sign(addr, &spk, to_spend.compute_txid(), &tx)
}

pub(crate) fn signed_msg_hash(network: Network, message: &[u8]) -> Message {
    let mut data = network.message_magic().to_vec();
    data.extend(serialize(&bitcoin::VarInt(message.len() as u64)));
    data.extend_from_slice(message);
    msg_of(sha256d::Hash::hash(&data))
}

fn verify_bip137(addr: &Addr, network: Network, message: &[u8], sig: &[u8]) -> Result<(), String> {
    let Kind::P2pkh(h) = addr.kind else {
        return Err("BIP-137 is accepted for P2PKH only".into());
    };
    if sig.len() != 65 || !(27..=34).contains(&sig[0]) {
        return Err("bad BIP-137 header".into());
    }
    let flag = sig[0] - 27;
    let compressed = flag >= 4;
    let rec = RecoveryId::from_i32((flag & 3) as i32).map_err(|_| "bad recovery id")?;
    let rsig = RecoverableSignature::from_compact(&sig[1..], rec).map_err(|_| "bad compact signature")?;
    let pk = secp()
        .recover_ecdsa(&signed_msg_hash(network, message), &rsig)
        .map_err(|_| "recovery failed")?;
    let ser: Vec<u8> =
        if compressed { pk.serialize().to_vec() } else { pk.serialize_uncompressed().to_vec() };
    if h160(&ser) == h {
        Ok(())
    } else {
        Err("invalid signature".into())
    }
}

/// Result with a reason; `verify` flattens it to a bool.
pub fn verify_detailed(
    address: &str,
    message: &str,
    signature: &str,
    network: &str,
) -> Result<(), String> {
    if message.len() > MAX_MESSAGE_BYTES || signature.len() > MAX_SIGNATURE_CHARS {
        return Err("input too large".into());
    }
    let want = Network::parse(network)?;
    let addr = decode_address(address, want)?;
    if let Some(w) = want {
        if !addr.matches(w) {
            return Err("address does not belong to the requested network".into());
        }
    }
    let msg = message.as_bytes();
    let signature = signature.trim();
    let dec = |s: &str| b64().decode(s).map_err(|_| "bad base64".to_string());
    if let Some(rest) = signature.strip_prefix("smp") {
        verify_simple(&addr, msg, &dec(rest)?)
    } else if let Some(rest) = signature.strip_prefix("ful") {
        verify_full(&addr, msg, &dec(rest)?)
    } else if signature.starts_with("pof") {
        Err("proof of funds is not supported".into())
    } else {
        let bytes = dec(signature)?;
        if matches!(addr.kind, Kind::P2pkh(_)) && bytes.len() == 65 {
            // A base58 test address does not say whether it is a Bitcoin or Litecoin key; with no
            // network label try both message magics.
            let ltc = Network { chain: Chain::Ltc, net: addr.network.net };
            let btc = Network { chain: Chain::Btc, net: addr.network.net };
            let tries: Vec<Network> = if addr.test_or_reg && want.is_none() { vec![btc, ltc] } else { vec![addr.network] };
            if tries.iter().any(|n| verify_bip137(&addr, *n, msg, &bytes).is_ok()) {
                Ok(())
            } else {
                Err("invalid signature".into())
            }
        } else {
            verify_simple(&addr, msg, &bytes)
        }
    }
}

pub fn verify(address: &str, message: &str, signature: &str, network: &str) -> bool {
    std::panic::catch_unwind(|| verify_detailed(address, message, signature, network).is_ok())
        .unwrap_or(false)
}
