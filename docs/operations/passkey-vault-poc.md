# Passkey vault proof of concept

The production implementation now has its own
[encrypted-storage migration and deployment guide](encrypted-storage.md).
This standalone experiment remains separate and is never a migration source.

This is a **separate, experimental app**, not encryption of production Approval
MCP storage. It never loads the production configuration, passkeys, credentials,
master key, plugin code, or audit history. Do not put real secrets into it or
point it at a production data directory. Production storage behavior is unchanged.

## Run

From the repository root, using Node.js 24 and installed dependencies:

```bash
npm run poc:passkey-vault
```

Open `http://localhost:43129` in the actual browser/passkey provider you want to
test. Use a stable hostname and port for the entire experiment. The default
file is `.local-data/passkey-vault-poc/poc-vault.json`, which is ignored by Git.
The server binds to `127.0.0.1` by default. This port is separate from Approval
MCP's usual `43127`.

For a different location or an HTTPS reverse proxy, configure:

```text
POC_DATA_DIR=/absolute/path/to/a/separate-poc-directory
POC_PORT=43129
POC_HOST=127.0.0.1
POC_PUBLIC_URL=https://your-controlled-test-host.example
```

The public URL must reach this process and preserve its Host header. HTTPS is
required outside exact loopback. Restrict access to your controlled test
environment: first enrollment is intentionally a local experimental bootstrap,
not a production administrator onboarding protocol.

## Manual test

1. Click **Create with passkey**, then **Finish encrypted setup**. Registration
   and PRF evaluation each have an explicit user gesture and passkey prompt.
   Complete setup within two minutes, or use **Start setup over**. The app
   requires actual 32-byte PRF output; login success alone is
   not sufficient. Unsupported PRF stops enrollment without a weaker fallback.
2. Save the displayed **recovery key** offline. It is not the existing Approval
   MCP login recovery code, and is not written to the vault file or browser storage.
3. Verify that the synthetic sample appears. Lock the vault, then unlock with
   your passkey. Closing the browser does not lock the process.
4. Stop and restart the PoC with the same data directory and URL. It must start
   locked. Unlock it again using the same passkey.
5. Lock it and select **Use a recovery key instead**. A wrong key must fail;
   the saved key must unlock without the passkey.

Existing invalid vault files or a changed origin cause startup to fail without
overwriting the file. There is no destructive reset button. Keep the recovery
key before experimenting with credential deletion or passkey synchronization.

## What is actually encrypted

The browser generates a random 256-bit data encryption key (DEK). A passkey's
WebAuthn PRF output is domain-separated through HKDF-SHA-256 into a wrapping
key; AES-256-GCM wraps the DEK. A separately generated random recovery key gets
its own wrapping context and a second encrypted copy of the same DEK. The DEK
encrypts one fixed synthetic message with authenticated vault identity and
fresh random nonces. Public credential metadata and wrapping envelopes remain
outside the encrypted sample, so authentication can start while locked.

PRF output and recovery secrets stay in browser memory and are deliberately
excluded from WebAuthn JSON sent to the server. Only the unwrapped DEK is sent
directly to the server over the configured HTTPS/loopback connection, bound to
a verified passkey assertion (or proof of the recovery DEK). The server needs
that key to perform background work; this is **not end-to-end encryption against
the running server**. It holds the active DEK in process memory, not in the vault
file or environment. Lock drops the reference and best-effort clears the buffer;
JavaScript, process dumps, swap and a compromised operating system are outside
the PoC's protection. Restart always loses the active key.

Only an authenticated PoC session can read the sample while unlocked. The
standalone HTTP app checks Host, Origin and CSRF, bounds request bodies, rate
limits attempts, and does not log request bodies, keys, or recovery codes.

## Automated verification and remaining work

`npm test` covers crypto round-trips, wrong keys, context separation, tampering,
locked cold starts, HTTP session isolation, recovery and restart. Install
Playwright Chromium, then run `npm run test:passkey-vault-ui` for a virtual PRF
authenticator test, including actual browser enrollment and passkey unlock.
`DEMO_CHROMIUM_EXECUTABLE` can select an existing browser executable.

Virtual authenticator success does **not** establish compatibility with Safari,
iCloud Keychain, third-party passkey managers or hardware keys. Record the
actual browser/OS/provider combination and verify repeated unwrap and recovery
before committing to production encryption.

The separate production implementation now covers state/history encryption,
multiple wrapping slots, cold-start readiness/MCP gating, and resumable migration.
Use its [deployment guide](encrypted-storage.md), not this experimental app,
to migrate data. A real deployment still needs a tested backup, provider-specific
verification and a controlled rollout. Keeping the old plaintext master key
in `.env` intentionally selects automatic unlock instead of passkey-only startup.
Untrusted plugin execution is another boundary: encrypted-at-rest storage does
not protect an unlocked server from a malicious plugin running with its permissions.

References: [WebAuthn PRF](https://www.w3.org/TR/webauthn-3/#sctn-prf-extension),
[Safari PRF support](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/).
