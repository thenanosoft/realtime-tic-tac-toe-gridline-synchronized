/**
 * End-to-end encryption for chat bodies (P8-01, P8-03, P8-05).
 *
 * The design is deliberately boring, because key distribution is where E2EE
 * designs usually fail. There is no key exchange here at all:
 *
 *   1. The room's creator generates 32 random bytes and puts them in the URL
 *      fragment. A fragment is never sent in an HTTP request and never appears
 *      in a WebSocket handshake, so the secret reaches the other player through
 *      the invite link and by no other route.
 *   2. Both sides derive generation `n` of the room key with HKDF-SHA256 over
 *      that secret, salted with the room code and labelled with the epoch.
 *      Agreeing on an integer is enough; nothing secret crosses the wire.
 *   3. Rotation increments the epoch. The new key is derived from the same
 *      secret under a different label, which is why a rotated key cannot read
 *      what the previous one sealed (P8-06) - not by policy, by construction.
 *
 * Derived keys are created non-extractable, so not even this module can read
 * the bytes back out of them once derived.
 */

const SECRET_BYTES = 32;
const IV_BYTES = 12;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

function subtle(): SubtleCrypto {
  const available = globalThis.crypto?.subtle;
  if (!available) {
    throw new DecryptionError('This browser does not provide the Web Crypto API, so private rooms are unavailable.');
  }
  return available;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * base64url, because this value lives in a URL.
 *
 * Standard base64 would survive a fragment too, but `+` and `/` get re-encoded
 * by enough share sheets and chat clients that the secret can come back
 * mangled - a corrupted key is indistinguishable from a wrong one, so it is
 * worth not having to tell them apart.
 */
export function generateRoomSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isRoomSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const padded = secret.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

/**
 * Derives generation `epoch` of a room's key.
 *
 * The room code is the HKDF salt rather than part of the info string so that
 * the same secret pasted into a different room produces a different key. That
 * matters for an invite link reused by accident: it fails to decrypt rather
 * than quietly working somewhere it was not meant to.
 */
export async function deriveRoomKey(secret: string, roomCode: string, epoch: number): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const material = await subtle().importKey('raw', secretBytes(secret), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(`gridline/room/${roomCode.toUpperCase()}`),
      info: encoder.encode(`gridline/e2ee/v1/epoch/${epoch}`),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    // Non-extractable: the derived key cannot be read back out, by this module
    // or by anything else running on the page.
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface SealedBody {
  /** Base64 ciphertext, including the AES-GCM tag. */
  body: string;
  /** Base64 nonce, fresh for this message. */
  iv: string;
}

export async function sealBytes(key: CryptoKey, plaintext: Uint8Array): Promise<SealedBody> {
  // A fresh IV per message, never a counter: a reused nonce under the same key
  // is the one mistake AES-GCM does not forgive.
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const sealed = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext as BufferSource);
  return { body: toBase64(new Uint8Array(sealed)), iv: toBase64(iv) };
}

export async function openBytes(key: CryptoKey, body: string, iv: string): Promise<Uint8Array> {
  try {
    const plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv) as BufferSource },
      key,
      fromBase64(body) as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    // AES-GCM authenticates: a failure here means the ciphertext was sealed
    // with a different key or was altered in transit. Both are the same answer
    // to the caller - this cannot be trusted - so they are not distinguished.
    throw new DecryptionError('This message could not be decrypted with the current room key.');
  }
}

export async function sealText(key: CryptoKey, plaintext: string): Promise<SealedBody> {
  return sealBytes(key, new TextEncoder().encode(plaintext));
}

export async function openText(key: CryptoKey, body: string, iv: string): Promise<string> {
  return new TextDecoder().decode(await openBytes(key, body, iv));
}
