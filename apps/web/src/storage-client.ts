export interface StorageStatus {
  locked: boolean; initialized: boolean; environmentUnlock: boolean; primaryOrigin: string;
  csrf: string; legacyKeyRequired: boolean; recoveryAvailable: boolean;
  bootstrapNotifications: boolean;
  slots: { id: string; name: string; createdAt: string }[];
}
interface Envelope { nonce: string; ciphertext: string }
interface AuthenticationOptions {
  challenge: string; rpId: string; userVerification: UserVerificationRequirement;
  allowCredentials: { id: string; type: PublicKeyCredentialType }[];
  extensions: { prf: { eval: { first: string } } };
}
interface Enrollment { id: string; slotId: string; options: AuthenticationOptions; key?: string | undefined; needsRecovery: boolean }
const encoder = new TextEncoder();
export const encodeBytes = (bytes: ArrayBuffer | Uint8Array<ArrayBuffer>) => btoa(String.fromCharCode(...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 100_000) throw new Error('Invalid key');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
}
export async function storageApi<T>(path: string, status?: StorageStatus, body?: unknown, adminCsrf?: string, method = 'POST'): Promise<T> {
  const response = await fetch(`/api/storage/${path}`, {
    cache: 'no-store', credentials: 'same-origin',
    ...(body === undefined ? {} : { method, headers: { 'content-type': 'application/json', 'x-storage-csrf': status!.csrf, ...(adminCsrf === undefined ? {} : { 'x-csrf-token': adminCsrf }) }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error('Storage operation failed');
  return response.json() as Promise<T>;
}
async function wrappingKey(secret: Uint8Array<ArrayBuffer>, id: string, purpose: string): Promise<CryptoKey> {
  if (secret.length !== 32) throw new Error('Expected a 32-byte key');
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(id), info: encoder.encode(`approval-mcp-storage-wrap:v1:${purpose}`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function wrapStorageKey(raw: Uint8Array<ArrayBuffer>, secret: Uint8Array<ArrayBuffer>, id: string, purpose: string): Promise<Envelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(`${id}:key:${purpose}`) }, await wrappingKey(secret, id, purpose), raw);
  return { nonce: encodeBytes(nonce), ciphertext: encodeBytes(ciphertext) };
}
export async function unwrapStorageKey(envelope: Envelope, secret: Uint8Array<ArrayBuffer>, id: string, purpose: string): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBytes(envelope.nonce), additionalData: encoder.encode(`${id}:key:${purpose}`) }, await wrappingKey(secret, id, purpose), decodeBytes(envelope.ciphertext)));
  if (raw.length !== 32) throw new Error('Invalid key');
  return raw;
}
function credentialJSON(credential: PublicKeyCredential, registration = false) {
  const response = credential.response;
  return { id: credential.id, rawId: encodeBytes(credential.rawId), type: credential.type,
    response: registration ? { clientDataJSON: encodeBytes(response.clientDataJSON), attestationObject: encodeBytes((response as AuthenticatorAttestationResponse).attestationObject), transports: (response as AuthenticatorAttestationResponse).getTransports() }
      : { clientDataJSON: encodeBytes(response.clientDataJSON), authenticatorData: encodeBytes((response as AuthenticatorAssertionResponse).authenticatorData), signature: encodeBytes((response as AuthenticatorAssertionResponse).signature), ...((response as AuthenticatorAssertionResponse).userHandle ? { userHandle: encodeBytes((response as AuthenticatorAssertionResponse).userHandle!) } : {}) },
    clientExtensionResults: {}, ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}) };
}
async function assertion(options: AuthenticationOptions) {
  const publicKey = { ...options, challenge: decodeBytes(options.challenge), allowCredentials: options.allowCredentials.map((v) => ({ ...v, id: decodeBytes(v.id) })), extensions: { prf: { eval: { first: decodeBytes(options.extensions.prf.eval.first) } } } };
  const credential = await navigator.credentials.get({ publicKey } as CredentialRequestOptions) as PublicKeyCredential | null;
  if (credential === null) throw new Error('No credential');
  const results = credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  const first = results.prf?.results?.first;
  if (first?.byteLength !== 32) throw new Error('storage.prfUnsupported');
  return { authentication: credentialJSON(credential), prf: new Uint8Array(first) };
}
export async function beginStorageEnrollment(status: StorageStatus, name: string, setupToken: string, adminCsrf?: string): Promise<Enrollment> {
  const options = await storageApi<Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'> & { challenge: string; user: Omit<PublicKeyCredentialUserEntity, 'id'> & { id: string }; excludeCredentials: { id: string; type: PublicKeyCredentialType }[] }>('enroll/options', status, { name, ...(adminCsrf === undefined ? { setupToken } : {}) }, adminCsrf);
  const credential = await navigator.credentials.create({ publicKey: { ...options, challenge: decodeBytes(options.challenge), user: { ...options.user, id: decodeBytes(options.user.id) }, excludeCredentials: (options.excludeCredentials ?? []).map((v) => ({ ...v, id: decodeBytes(v.id) })) } as PublicKeyCredentialCreationOptions }) as PublicKeyCredential | null;
  if (credential === null) throw new Error('No credential');
  return storageApi('enroll/verify', status, { credential: credentialJSON(credential, true), ...(adminCsrf === undefined ? { setupToken } : {}) }, adminCsrf);
}
export async function finishStorageEnrollment(status: StorageStatus, enrollment: Enrollment, setupToken: string, adminCsrf?: string): Promise<string | undefined> {
  const { authentication, prf } = await assertion(enrollment.options);
  const key = enrollment.key === undefined ? crypto.getRandomValues(new Uint8Array(32)) : decodeBytes(enrollment.key);
  const recovery = enrollment.needsRecovery ? crypto.getRandomValues(new Uint8Array(32)) : undefined;
  try {
    const purpose = `passkey:${enrollment.slotId}`;
    const passkeyWrap = await wrapStorageKey(key, prf, enrollment.id, purpose);
    const check = await unwrapStorageKey(passkeyWrap, prf, enrollment.id, purpose); check.fill(0);
    const recoveryWrap = recovery === undefined ? undefined : await wrapStorageKey(key, recovery, enrollment.id, 'recovery');
    await storageApi('enroll/complete', status, { authentication, key: encodeBytes(key), passkeyWrap, ...(recoveryWrap === undefined ? {} : { recoveryWrap }), ...(adminCsrf === undefined ? { setupToken } : {}) }, adminCsrf);
    return recovery === undefined ? undefined : encodeBytes(recovery);
  } finally { key.fill(0); prf.fill(0); recovery?.fill(0); enrollment.key = undefined; }
}
export async function unlockStorage(status: StorageStatus, slotId: string): Promise<void> {
  const vault = await storageApi<{ id: string; slots: { id: string; wrap: Envelope }[] }>('public');
  const slot = vault.slots.find((v) => v.id === slotId);
  if (slot === undefined) throw new Error('No passkey');
  const options = await storageApi<AuthenticationOptions>('unlock/options', status, { slotId });
  const { authentication, prf } = await assertion(options);
  let key: Uint8Array<ArrayBuffer> | undefined;
  try { key = await unwrapStorageKey(slot.wrap, prf, vault.id, `passkey:${slotId}`); await storageApi('unlock', status, { authentication, key: encodeBytes(key) }); }
  finally { key?.fill(0); prf.fill(0); }
}
export async function recoverStorage(status: StorageStatus, code: string): Promise<void> {
  const vault = await storageApi<{ id: string; recoveryWrap: Envelope }>('public');
  const secret = decodeBytes(code.trim());
  let key: Uint8Array<ArrayBuffer> | undefined;
  try { key = await unwrapStorageKey(vault.recoveryWrap, secret, vault.id, 'recovery'); await storageApi('recover', status, { key: encodeBytes(key) }); }
  finally { key?.fill(0); secret.fill(0); }
}
