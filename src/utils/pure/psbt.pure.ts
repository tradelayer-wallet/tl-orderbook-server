import { createHash } from "crypto";
import { IResult } from "../types/mix.types";

// The txid of the transaction a PSBT carries, as decodepsbt reports it (the wallets compare this value):
// the double SHA-256 of the unsigned transaction, byte-reversed. The unsigned transaction is the
// PSBT_GLOBAL_UNSIGNED_TX entry (BIP174). Signatures and final scripts live in the input maps, so the
// txid is the one the seller signed.

const PSBT_MAGIC = '70736274ff'; // "psbt" followed by 0xff
const PSBT_GLOBAL_UNSIGNED_TX = 0x00;

// Bounds-checked reader over a PSBT's bytes (CompactSize lengths, BIP174 key-value maps). Any read past
// the end throws, so a malformed PSBT never yields a txid.
class Reader {
    private offset = 0;

    constructor(private readonly bytes: Buffer) {}

    take(length: number): Buffer {
        if (this.offset + length > this.bytes.length) throw new Error('truncated');
        const out = this.bytes.subarray(this.offset, this.offset + length);
        this.offset += length;
        return out;
    }

    varint(): number {
        const first = this.take(1)[0];
        if (first < 0xfd) return first;
        if (first === 0xfd) return this.take(2).readUInt16LE(0);
        if (first === 0xfe) return this.take(4).readUInt32LE(0);
        throw new Error('length too large');
    }

    get done(): boolean {
        return this.offset === this.bytes.length;
    }
}

// The unsigned transaction bytes: the global map's PSBT_GLOBAL_UNSIGNED_TX entry, exactly once.
const unsignedTx = (psbt: Buffer): Buffer => {
    const reader = new Reader(psbt);
    if (reader.take(5).toString('hex') !== PSBT_MAGIC) throw new Error('not a PSBT');
    let tx: Buffer | null = null;
    for (let keyLength = reader.varint(); keyLength !== 0; keyLength = reader.varint()) {
        const key = reader.take(keyLength);
        const value = reader.take(reader.varint());
        if (key[0] === PSBT_GLOBAL_UNSIGNED_TX) {
            if (keyLength !== 1 || tx) throw new Error('unsigned transaction entry is malformed or repeated');
            tx = value;
        }
    }
    if (!tx) throw new Error('no unsigned transaction');
    return tx;
};

// A non-witness transaction: version, inputs, outputs, locktime, and nothing after them.
const checkTx = (tx: Buffer): void => {
    const reader = new Reader(tx);
    reader.take(4);
    const inputs = reader.varint();
    if (inputs === 0) throw new Error('witness serialization is not allowed in a PSBT');
    for (let i = 0; i < inputs; i++) {
        reader.take(36);
        reader.take(reader.varint());
        reader.take(4);
    }
    const outputs = reader.varint();
    for (let i = 0; i < outputs; i++) {
        reader.take(8);
        reader.take(reader.varint());
    }
    reader.take(4);
    if (!reader.done) throw new Error('trailing bytes after the transaction');
};

const doubleSha256 = (bytes: Buffer): Buffer =>
    createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest();

export const psbtTxid = (psbtHex: string): IResult<string> => {
    try {
        const tx = unsignedTx(Buffer.from(psbtHex, 'hex'));
        checkTx(tx);
        return { data: doubleSha256(tx).reverse().toString('hex') };
    } catch (error) {
        return { error: 'PSBT does not carry a valid unsigned transaction' };
    }
};
