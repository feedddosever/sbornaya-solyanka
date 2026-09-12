/**
 * Sealing the document handover.
 *
 * THE PROBLEM THIS SOLVES, which is easy to get wrong and expensive to get
 * wrong: an encrypted Swarm reference is 128 hex characters WITH THE DECRYPTION
 * KEY EMBEDDED. The reference is the capability. Arkiv entities, meanwhile, are
 * public and verifiable by design - Arkiv's own brief says outright that it is
 * not a confidentiality layer. So writing that reference into an Arkiv
 * attribute would publish every invoice in the system to the entire network.
 *
 * THE FIX, which also makes three of the four layers interlock:
 *   1. a PUBLIC redacted teaser is uploaded unencrypted; its reference goes in
 *      the Arkiv listing and powers discovery
 *   2. the FULL invoice is uploaded encrypted; its reference is never published
 *   3. keccak256(fullReference) is committed on Avalanche as `docHash` - public
 *      proof the document exists and has not changed, revealing nothing
 *   4. on sale, the issuer reads the buyer's public key FROM THEIR ENSv2
 *      RESOLVER RECORD, seals the reference to it, and posts the ciphertext as
 *      a short-lived Arkiv entity. Only the buyer can open it.
 *
 * The construction below is ECIES: ephemeral ECDH over secp256k1, HKDF-SHA256
 * to a symmetric key, XChaCha20-Poly1305 for authenticated encryption. Both
 * @noble packages are already transitive dependencies of viem.
 *
 * Wire format (hex, no prefix):
 *   [65 bytes ephemeral uncompressed pubkey][24 bytes nonce][ciphertext+tag]
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";
import { bytesToHex, hexToBytes, keccak256, toHex } from "viem";

const INFO = new TextEncoder().encode("factor/handover/v1");

function deriveKey(sharedSecret: Uint8Array, ephPub: Uint8Array): Uint8Array {
  // Bind the derived key to the ephemeral public key so a ciphertext cannot be
  // replayed under a different ephemeral point.
  return hkdf(sha256, sharedSecret, ephPub, INFO, 32);
}

/**
 * Seal a plaintext to a recipient's secp256k1 public key.
 * @param recipientPubKey 33-byte compressed or 65-byte uncompressed, hex
 */
export function sealTo(recipientPubKey: `0x${string}`, plaintext: string): `0x${string}` {
  const recipient = hexToBytes(recipientPubKey);
  if (recipient.length !== 33 && recipient.length !== 65) {
    throw new Error(
      `recipient public key must be 33 or 65 bytes, got ${recipient.length}`,
    );
  }

  const ephPriv = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, false); // uncompressed, 65 bytes

  // getSharedSecret returns a 33-byte compressed point; drop the prefix byte
  // and use the x-coordinate, which is the standard ECDH output.
  const shared = secp256k1.getSharedSecret(ephPriv, recipient, true).slice(1);
  const key = deriveKey(shared, ephPub);

  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(
    new TextEncoder().encode(plaintext),
  );

  const out = new Uint8Array(ephPub.length + nonce.length + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, ephPub.length);
  out.set(ct, ephPub.length + nonce.length);
  return bytesToHex(out);
}

/** Open a sealed envelope with the recipient's private key. */
export function openSealed(recipientPrivKey: `0x${string}`, sealed: `0x${string}`): string {
  const blob = hexToBytes(sealed);
  if (blob.length < 65 + 24 + 16) throw new Error("sealed blob too short");

  const ephPub = blob.slice(0, 65);
  const nonce = blob.slice(65, 89);
  const ct = blob.slice(89);

  const priv = hexToBytes(recipientPrivKey);
  const shared = secp256k1.getSharedSecret(priv, ephPub, true).slice(1);
  const key = deriveKey(shared, ephPub);

  const pt = xchacha20poly1305(key, nonce).decrypt(ct);
  return new TextDecoder().decode(pt);
}

/**
 * The on-chain commitment to the full document.
 *
 * Committing to the REFERENCE (not the file bytes) is the right choice here:
 * the reference is itself derived from the content, so it already binds the
 * bytes, and hashing it lets us prove "this is the document we listed" without
 * ever holding the file on-chain or revealing the decryption key.
 */
export function commitToReference(reference: string): `0x${string}` {
  return keccak256(toHex(reference));
}

export function verifyCommitment(reference: string, commitment: `0x${string}`): boolean {
  return commitToReference(reference).toLowerCase() === commitment.toLowerCase();
}

/**
 * Reconstruct an uncompressed secp256k1 public key from an ENSv2 `pubkey`
 * record, which stores the point as two bytes32 words (x, y).
 */
export function pubkeyFromEnsRecord(x: `0x${string}`, y: `0x${string}`): `0x${string}` {
  const xs = x.slice(2).padStart(64, "0");
  const ys = y.slice(2).padStart(64, "0");
  return `0x04${xs}${ys}` as `0x${string}`;
}
