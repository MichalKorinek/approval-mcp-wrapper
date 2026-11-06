// Shared with the browser. No production state, credentials or master key.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export function fromBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 100_000) throw new Error('Invalid base64url');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
}
export const randomKey = () => crypto.getRandomValues(new Uint8Array(32));
export const recoveryCode = () => toBase64(randomKey());

async function wrappingKey(secret, vaultId, purpose) {
  if (secret.byteLength !== 32) throw new Error('Expected a 32-byte wrapping secret');
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(vaultId),
    info: encoder.encode(`approval-mcp-vault-poc:v1:${purpose}`) }, material,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function dataKey(raw) {
  if (raw.byteLength !== 32) throw new Error('Expected a 32-byte data key');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function seal(key, bytes, context) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(context) }, key, bytes);
  return { nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) };
}
async function unseal(key, envelope, context) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.nonce),
    additionalData: encoder.encode(context) }, key, fromBase64(envelope.ciphertext)));
}
export async function wrapKey(rawKey, secret, vaultId, purpose) {
  return seal(await wrappingKey(secret, vaultId, purpose), rawKey, `${vaultId}:key:${purpose}`);
}
export async function unwrapKey(envelope, secret, vaultId, purpose) {
  return unseal(await wrappingKey(secret, vaultId, purpose), envelope, `${vaultId}:key:${purpose}`);
}
export async function encryptSample(rawKey, vaultId, value) {
  return seal(await dataKey(rawKey), encoder.encode(JSON.stringify(value)), `${vaultId}:sample:v1`);
}
export async function decryptSample(rawKey, vaultId, envelope) {
  return JSON.parse(decoder.decode(await unseal(await dataKey(rawKey), envelope, `${vaultId}:sample:v1`)));
}
