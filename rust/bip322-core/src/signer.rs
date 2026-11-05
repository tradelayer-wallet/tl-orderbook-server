//! Signing counterpart used by tests and the addon's `testSignBip322` helper. It signs with a
//! caller-supplied secret key; nothing in the server calls it.

use crate::{
    base58_versions, h160, hrp_for, msg_of, push, signed_msg_hash, to_sign_skeleton, to_spend_tx,
    Addr, Kind, Network,
};
use bitcoin::{
    base58,
    bech32::{self, Fe32, Hrp},
    consensus::encode::serialize,
    key::{Keypair, TapTweak},
    script::Builder,
    secp256k1::{Secp256k1, SecretKey},
    sighash::{EcdsaSighashType, Prevouts, SighashCache, TapSighashType},
    Amount, CompressedPublicKey, TxOut, Witness,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AddrType {
    P2pkh,
    P2shP2wpkh,
    P2wpkh,
    P2tr,
}

impl AddrType {
    pub fn parse(s: &str) -> Result<AddrType, String> {
        match s.to_ascii_lowercase().as_str() {
            "p2pkh" => Ok(AddrType::P2pkh),
            "p2sh-p2wpkh" | "p2shp2wpkh" => Ok(AddrType::P2shP2wpkh),
            "p2wpkh" => Ok(AddrType::P2wpkh),
            "p2tr" => Ok(AddrType::P2tr),
            other => Err(format!("unknown address type '{other}'")),
        }
    }
}

pub struct Signed {
    pub address: String,
    pub signature: String,
}

fn kind_for(sk: &SecretKey, ty: AddrType, network: Network) -> Kind {
    let secp = Secp256k1::new();
    let pk = CompressedPublicKey(sk.public_key(&secp));
    let pkh = h160(&pk.to_bytes());
    match ty {
        AddrType::P2pkh => Kind::P2pkh(pkh),
        AddrType::P2wpkh => Kind::P2wpkh(pkh),
        AddrType::P2shP2wpkh => {
            let redeem = push(Builder::new().push_int(0), &pkh).into_script();
            Kind::P2sh(h160(redeem.as_bytes()))
        }
        AddrType::P2tr => {
            let kp = Keypair::from_secret_key(&secp, sk);
            let (x, _) = kp.tap_tweak(&secp, None).to_keypair().x_only_public_key();
            let _ = network;
            Kind::P2tr(x.serialize())
        }
    }
}

pub fn encode_address(kind: Kind, network: Network) -> String {
    let hrp = Hrp::parse(hrp_for(network)).expect("static hrp");
    let (v_pkh, v_sh) = base58_versions(network);
    match kind {
        Kind::P2pkh(h) => {
            let mut p = vec![v_pkh];
            p.extend_from_slice(&h);
            base58::encode_check(&p)
        }
        Kind::P2sh(h) => {
            let mut p = vec![v_sh];
            p.extend_from_slice(&h);
            base58::encode_check(&p)
        }
        Kind::P2wpkh(h) => bech32::segwit::encode(hrp, Fe32::Q, &h).unwrap(),
        Kind::P2wsh(h) => bech32::segwit::encode(hrp, Fe32::Q, &h).unwrap(),
        Kind::P2tr(x) => bech32::segwit::encode(hrp, Fe32::P, &x).unwrap(),
    }
}

pub fn address_for(secret: [u8; 32], ty: AddrType, network: Network) -> Result<String, String> {
    let sk = SecretKey::from_slice(&secret).map_err(|e| e.to_string())?;
    Ok(encode_address(kind_for(&sk, ty, network), network))
}

/// BIP-322 simple (`smp`) for P2WPKH / P2SH-P2WPKH / P2TR, BIP-137 (unprefixed) for P2PKH.
pub fn sign(secret: [u8; 32], ty: AddrType, network: Network, message: &str) -> Result<Signed, String> {
    use base64::Engine as _;
    let sk = SecretKey::from_slice(&secret).map_err(|e| e.to_string())?;
    let secp = Secp256k1::new();
    let kind = kind_for(&sk, ty, network);
    let address = encode_address(kind, network);
    let addr = Addr { network, test_or_reg: false, kind };
    let b64 = base64::engine::general_purpose::STANDARD;

    if ty == AddrType::P2pkh {
        let (rec, compact) = secp
            .sign_ecdsa_recoverable(&signed_msg_hash(network, message.as_bytes()), &sk)
            .serialize_compact();
        let mut out = vec![27 + 4 + rec.to_i32() as u8];
        out.extend_from_slice(&compact);
        return Ok(Signed { address, signature: b64.encode(out) });
    }

    let spk = addr.script_pubkey();
    let to_spend = to_spend_tx(message.as_bytes(), &spk);
    let to_sign = to_sign_skeleton(&to_spend);
    let mut cache = SighashCache::new(&to_sign);
    let pk = CompressedPublicKey(sk.public_key(&secp));
    let witness = match ty {
        AddrType::P2wpkh | AddrType::P2shP2wpkh => {
            let script = if ty == AddrType::P2wpkh {
                spk.clone()
            } else {
                push(Builder::new().push_int(0), &h160(&pk.to_bytes())).into_script()
            };
            let hash = cache
                .p2wpkh_signature_hash(0, &script, Amount::ZERO, EcdsaSighashType::All)
                .map_err(|e| e.to_string())?;
            let sig = bitcoin::ecdsa::Signature {
                signature: secp.sign_ecdsa(&msg_of(hash), &sk),
                sighash_type: EcdsaSighashType::All,
            };
            Witness::from_slice(&[sig.serialize().to_vec(), pk.to_bytes().to_vec()])
        }
        AddrType::P2tr => {
            let prevout = TxOut { value: Amount::ZERO, script_pubkey: spk.clone() };
            let hash = cache
                .taproot_key_spend_signature_hash(0, &Prevouts::All(&[prevout]), TapSighashType::Default)
                .map_err(|e| e.to_string())?;
            let kp = Keypair::from_secret_key(&secp, &sk).tap_tweak(&secp, None).to_keypair();
            let sig = bitcoin::taproot::Signature {
                signature: secp.sign_schnorr_no_aux_rand(&msg_of(hash), &kp),
                sighash_type: TapSighashType::Default,
            };
            Witness::from_slice(&[sig.serialize().to_vec()])
        }
        AddrType::P2pkh => unreachable!(),
    };
    Ok(Signed { address, signature: format!("smp{}", b64.encode(serialize(&witness))) })
}
