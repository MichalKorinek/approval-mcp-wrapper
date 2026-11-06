import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptSample, encryptSample, fromBase64, randomKey, recoveryCode, toBase64, unwrapKey, wrapKey } from './crypto.mjs';

test('passkey wrapping, payload encryption, and independent recovery round-trip', async () => {
  const id = crypto.randomUUID();
  const key = randomKey();
  const prf = randomKey();
  const code = recoveryCode();
  const recovery = fromBase64(code);
  const passkeyWrap = await wrapKey(key, prf, id, 'passkey');
  const recoveryWrap = await wrapKey(key, recovery, id, 'recovery');
  const value = { message: 'synthetic test', createdAt: new Date().toISOString() };
  const payload = await encryptSample(key, id, value);
  assert.deepEqual(await unwrapKey(passkeyWrap, prf, id, 'passkey'), key);
  assert.deepEqual(await unwrapKey(recoveryWrap, recovery, id, 'recovery'), key);
  assert.deepEqual(await decryptSample(key, id, payload), value);
  const disk = JSON.stringify({ passkeyWrap, recoveryWrap, payload });
  for (const secret of [toBase64(key), toBase64(prf), code, value.message]) assert.equal(disk.includes(secret), false);
});
test('wrong secrets, changed vault identity, cross-purpose wraps and tampering fail closed', async () => {
  const id = crypto.randomUUID();
  const key = randomKey();
  const prf = randomKey();
  const wrapped = await wrapKey(key, prf, id, 'passkey');
  await assert.rejects(unwrapKey(wrapped, randomKey(), id, 'passkey'));
  await assert.rejects(unwrapKey(wrapped, prf, crypto.randomUUID(), 'passkey'));
  await assert.rejects(unwrapKey(wrapped, prf, id, 'recovery'));
  const ciphertext = fromBase64(wrapped.ciphertext);
  ciphertext[0] ^= 1;
  await assert.rejects(unwrapKey({ ...wrapped, ciphertext: toBase64(ciphertext) }, prf, id, 'passkey'));
});
