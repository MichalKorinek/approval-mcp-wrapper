import { decryptSample, encryptSample, fromBase64, randomKey, recoveryCode, toBase64, unwrapKey, wrapKey } from './crypto.mjs';

const element = (id) => document.getElementById(id);
let csrf;
let busy = false;
let current;
let enrollment;
function feedback(text, failed = false) {
  element('feedback').textContent = text;
  element('feedback').className = failed ? 'feedback error' : 'feedback';
}
async function api(path, data) {
  const response = await fetch(path, data === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-poc-csrf': csrf }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Request failed');
  return result;
}
async function refresh() {
  current = await api('/api/status');
  csrf = current.csrf;
  element('state').textContent = !current.initialized ? 'Not initialized' : current.locked ? 'Locked' : 'Unlocked';
  element('state').className = `state ${current.locked ? '' : 'unlocked'}`;
  element('setup').hidden = current.initialized;
  element('create').hidden = enrollment !== undefined;
  element('finish-setup').hidden = enrollment === undefined;
  element('restart-setup').hidden = enrollment === undefined;
  element('unlock-section').hidden = !current.initialized;
  element('sample-section').hidden = current.locked || !current.authenticated;
  element('lock').disabled = busy || current.locked || !current.authenticated;
  if (!current.locked && current.authenticated) {
    const sample = await api('/api/sample');
    element('sample').textContent = sample.message;
  } else { element('sample').textContent = ''; }
}
function registrationOptions(json) {
  return { ...json, challenge: fromBase64(json.challenge), user: { ...json.user, id: fromBase64(json.user.id) },
    excludeCredentials: json.excludeCredentials?.map((item) => ({ ...item, id: fromBase64(item.id) })) };
}
function authenticationOptions(json) {
  return { ...json, challenge: fromBase64(json.challenge),
    allowCredentials: json.allowCredentials?.map((item) => ({ ...item, id: fromBase64(item.id) })),
    extensions: { prf: { eval: { first: fromBase64(json.extensions.prf.eval.first) } } } };
}
function registrationJSON(credential) {
  return { id: credential.id, rawId: toBase64(credential.rawId), type: credential.type,
    response: { clientDataJSON: toBase64(credential.response.clientDataJSON), attestationObject: toBase64(credential.response.attestationObject),
      transports: credential.response.getTransports?.() ?? [] },
    clientExtensionResults: {},
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
  };
}
function authenticationJSON(credential) {
  return { id: credential.id, rawId: toBase64(credential.rawId), type: credential.type,
    response: { clientDataJSON: toBase64(credential.response.clientDataJSON), authenticatorData: toBase64(credential.response.authenticatorData),
      signature: toBase64(credential.response.signature),
      ...(credential.response.userHandle ? { userHandle: toBase64(credential.response.userHandle) } : {}) },
    // Intentionally omit all extension outputs. PRF secrets stay in this browser.
    clientExtensionResults: {},
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
  };
}
async function assertion(options) {
  const credential = await navigator.credentials.get({ publicKey: authenticationOptions(options) });
  const output = credential?.getClientExtensionResults().prf?.results?.first;
  if (output === undefined || output === null || output.byteLength !== 32) {
    throw new Error('This passkey/browser did not return PRF key material. Nothing was downgraded to login-only encryption. Try a compatible passkey provider or use the recovery key for an existing vault.');
  }
  return { authentication: authenticationJSON(credential), prf: new Uint8Array(output) };
}
async function run(action) {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  feedback('Waiting for your passkey or processing the encrypted test vault…');
  try { await action(); }
  catch (error) { feedback(error.name === 'NotAllowedError' ? 'The passkey operation was cancelled or unavailable. You can try again.' : error.message, true); }
  finally {
    busy = false;
    for (const button of document.querySelectorAll('button')) button.disabled = false;
    await refresh().catch(() => feedback('The PoC server is unavailable. Restart it with the same URL and data directory.', true));
  }
}

element('create').addEventListener('click', () => run(async () => {
  element('recovery-output').hidden = true;
  element('new-recovery-code').value = '';
  const options = await api('/api/enroll/options', {});
  const credential = await navigator.credentials.create({ publicKey: registrationOptions(options) });
  enrollment = await api('/api/enroll/verify', registrationJSON(credential));
  feedback('Passkey registered for this experiment. Click Finish encrypted setup to evaluate PRF with a separate user gesture.');
}));
element('finish-setup').addEventListener('click', () => run(async () => {
  if (enrollment === undefined) throw new Error('Register a PoC passkey first.');
  const { authentication, prf } = await assertion(enrollment.options);
  const key = randomKey();
  const code = recoveryCode();
  const recovery = fromBase64(code);
  try {
    const passkeyWrap = await wrapKey(key, prf, enrollment.id, 'passkey');
    const recoveryWrap = await wrapKey(key, recovery, enrollment.id, 'recovery');
    const payload = await encryptSample(key, enrollment.id, { message: 'Synthetic data — no Approval MCP secrets.', createdAt: new Date().toISOString() });
    await api('/api/enroll/complete', { authentication, passkeyWrap, recoveryWrap, payload, key: toBase64(key) });
    enrollment = undefined;
    element('new-recovery-code').value = code;
    element('recovery-output').hidden = false;
    feedback('Encrypted test vault created and unlocked. Save the recovery key below before locking or restarting.');
  } finally { key.fill(0); prf.fill(0); recovery.fill(0); }
}));
element('restart-setup').addEventListener('click', () => run(async () => {
  enrollment = undefined;
  feedback('Setup restarted. No vault was created. You can register using another passkey provider.');
}));
element('unlock').addEventListener('click', () => run(async () => {
  const vault = await api('/api/vault');
  const options = await api('/api/unlock/options', {});
  const { authentication, prf } = await assertion(options);
  let key;
  try {
    key = await unwrapKey(vault.passkeyWrap, prf, vault.id, 'passkey');
    await decryptSample(key, vault.id, vault.payload);
    await api('/api/unlock', { authentication, key: toBase64(key) });
    feedback('Unlocked with passkey-derived key material. The server can now read the synthetic sample.');
  } finally { prf.fill(0); key?.fill(0); }
}));
element('recover').addEventListener('click', () => run(async () => {
  let recovery;
  let key;
  try {
    const vault = await api('/api/vault');
    recovery = fromBase64(element('recovery-code').value.trim());
    key = await unwrapKey(vault.recoveryWrap, recovery, vault.id, 'recovery');
    await api('/api/recover', { key: toBase64(key) });
    feedback('Unlocked using the separate recovery key. No passkey was required for this recovery.');
  } catch { throw new Error('Recovery failed. Check that this is the recovery key for this PoC vault.'); }
  finally { recovery?.fill(0); key?.fill(0); element('recovery-code').value = ''; }
}));
element('lock').addEventListener('click', () => run(async () => {
  await api('/api/lock', {});
  element('new-recovery-code').value = '';
  element('recovery-output').hidden = true;
  feedback('Locked. The server dropped its active key. Restarting the PoC also starts locked.');
}));
element('dismiss-recovery').addEventListener('click', () => {
  element('new-recovery-code').value = '';
  element('recovery-output').hidden = true;
});

if (!isSecureContext || !globalThis.PublicKeyCredential || !crypto.subtle) {
  feedback('Use a secure HTTPS origin or localhost with a browser that supports WebAuthn and PRF.', true);
  for (const button of document.querySelectorAll('button')) button.disabled = true;
} else { await refresh().catch((error) => feedback(error.message, true)); }
