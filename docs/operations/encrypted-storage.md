# Encrypted storage and locked startup

Approval MCP encrypts its configuration snapshot/journal, all call-history
segments (including existing compressed segments), and history indexes. The
same application master key still decrypts existing upstream credentials and
Web Push records; those keys are not rotated by migration.

## Two startup modes

| Configuration | Startup behavior |
| --- | --- |
| `APPROVAL_MCP_MASTER_KEY` set to the original canonical base64 key | Migrate if necessary, decrypt storage, and start MCP automatically. |
| Environment key absent or empty, storage passkey configured | Serve the unlock UI, static assets, liveness, and storage unlock endpoints only. Start MCP after passkey/recovery unlock. |
| Environment key absent, completely fresh directory | Require the one-time setup code printed in server logs, then two explicit passkey prompts and a saved recovery key. |
| Environment key absent, legacy data without a vault manifest | Refuse to migrate. Restore the original environment key; never generate a replacement. |

While locked, `/health/live` returns 200, `/health/ready` returns 503, `/mcp`
and OAuth discovery return 503 with `storage_locked`, and normal application
APIs return 423. Upstreams, plugins, retention jobs, OAuth state and pending
approvals are not loaded until unlock. Keep liveness separate from readiness
so a health supervisor does not continuously restart a deliberately locked
server. Existing OAuth tokens are preserved; a locked server does not turn
their requests into authentication failures.

Unlocking makes the server operational until it exits. Closing the browser
does not lock it, and this version deliberately has no mid-call manual lock
button. Restart without the environment key to return to locked mode.

## Upgrade an existing deployment

1. Stop agent traffic and the old process. Back up **the complete existing
   data volume** and retain its matching original master key separately.
   There must be exactly one writer; do not run old/new containers against
   the same volume or use rolling replicas sharing this directory.
2. Start the new version with the **unchanged data mount, public URL and
   `APPROVAL_MCP_MASTER_KEY`**. The first run automatically migrates data.
   Allow time and disk space for encrypted active files plus an encrypted
   pre-migration archive. Previously compressed history can expand substantially:
   independent encrypted records no longer compress like the original JSON.
   Budget against **uncompressed** history size plus ciphertext/archive overhead,
   not merely the current compressed volume size. A disk-full failure stops
   migration before legacy cleanup and can resume after adding space.
3. Confirm readiness, administrator login, upstream credentials, history,
   and notification-device tests. Existing administrator passkeys, OAuth
   grants, plugin assignments and notification subscriptions are retained.
4. In **System → Encrypted storage**, name and register a storage passkey.
   Click **Finish encrypted setup** for the separate PRF prompt. Save the
   displayed storage recovery key offline before navigating away. Test the
   actual browser/provider combination; ordinary passkey login alone is
   not sufficient evidence of PRF support.
5. Keep a safe copy of the original environment key, then remove it from
   the actual container environment/Compose configuration and recreate
   the container. Removing it from a local `.env` file alone does not
   modify an already running container. An empty value also selects locked
   startup. Do not generate a different master key.
6. Expect a generic notification on registered devices: **The server is
   locked. Unlock it with your passkey.** Its link opens `/unlock` on the
   existing application origin. Unlock and verify readiness and history.
7. Also test the independent storage recovery key after a locked restart.
   It is different from the administrator login recovery codes.

Additional storage passkeys can be named and added from another provider or
device. Remove old ones in System only after testing their replacement. The
last storage passkey cannot be removed. Synced copies of the same iCloud
credential are one passkey, not independent recovery credentials. Existing
administrator login remains separate. On a brand-new passkey-only install,
the verified first storage credential also establishes the first administrator,
preventing an unauthenticated visitor from claiming administrator bootstrap
after the storage owner has completed setup.

## Migration and interrupted startup

The root volume now contains:

- `storage-vault.json`: versioned public credential metadata, per-passkey
  encrypted wrapping slots, encrypted recovery wrapping, a key check and
  authenticated migration metadata. It contains no plaintext data key.
- `storage-v1/`: encrypted state files and encrypted `calls/` segments/indexes.
- `storage-migration-backup/`: encrypted copies of the original legacy files,
  bound to their original paths and checked against recorded SHA-256 hashes.
- `plugins/`: cached **public executable plugin code**, not secret storage.
- `storage-unlock-push.json`: the deliberate notification exception below.

Before publishing a migration manifest, the server replays the legacy state
and verifies the old key against encrypted upstream/Web Push credentials.
It then durably archives each original, writes encrypted active files and
rebuilds history indexes with ciphertext byte offsets. State and history are
validated before legacy files are removed. Abandoned legacy temporary files
are archived, not activated. The final ready marker is committed atomically.
Migration phase, source paths/hashes, and wrapping metadata are authenticated
with the storage key; editing the marker cannot authorize a new plaintext
import.
An incomplete final legacy history record is preserved in the encrypted
archive and omitted from active history, matching the old journal's crash
recovery rule. New writes never append onto that fragment.

A crash before the ready marker leaves migration resumable: restart with
the same volume and original key. Already archived originals are verified
and reused even if part of legacy cleanup completed. Never delete the vault
manifest to retry setup: encrypted files without their manifest fail closed.
Unknown files in the old `calls/` directory must be reviewed by an operator.
If old root state/history files reappear after migration, startup also refuses
to continue: stop the old writer and investigate before choosing which data
to retain. Never let two versions independently write different layouts.
Do not edit checksums or replace missing/corrupt files with empty files.

The logical legacy files are removed after validation, not retained as a
second plaintext copy. This is **not secure erasure** of old disk blocks,
filesystem snapshots, external backups, old `.env` files or Docker/container
configuration. Manage those copies independently. The encrypted migration
archive can be retained for rollback; it is a pre-upgrade snapshot, not a
current backup.

## Notification delivery while locked

Sending Web Push requires its VAPID private key and subscription delivery
material. These cannot live exclusively inside a vault that is still locked.
With startup notifications enabled (default), the server keeps a separate
mode-0600 `storage-unlock-push.json` containing **only** that delivery material
and device locale. It is readable by the server account **without passkey
unlock**. It does not contain the storage key, upstream tokens, messages,
approval arguments, agent data or history. The main vault still encrypts its
own Web Push records. Do not describe the entire volume as uniformly secret
without noting this exception.

Device registration/removal synchronizes this startup copy. Startup sends
one generic notification per destination, with a fixed unlock link and no
tool details. Provider failures cannot prevent serving the unlock page.
Acceptance by a provider does not guarantee OS display. A fresh installation
has no destinations until notifications are registered in System. The
application public URL must be available, unchanged, and use HTTPS for push.

For a strict policy that forbids delivery credentials outside the main vault,
set `APPROVAL_MCP_UNLOCK_NOTIFICATIONS=false`. This removes the startup copy
and disables locked-start notifications; open `/unlock` manually instead.

## Backup, restore and rollback

Back up the **whole volume**, including `storage-vault.json`, `storage-v1/`,
the startup notification file and plugin cache. A backup of `storage-v1/`
alone is not a recoverable installation. Keep an independent recovery key
or original environment key; never paste those into chat or commit them.
Use the original public URL to retain passkey compatibility.

`restoreBackup` accepts an optional `masterKey: Uint8Array`. Without it, an
encrypted backup can have its paths, sizes and checksums validated, but the
result explicitly reports `decryptionValidated: false`. With the correct key,
it replays encrypted configuration as well. Unlock with the actual passkey
and verify readiness/history after restoring into a new directory.

Do not simply boot an older image against the migrated volume: the old root
state files have been removed. Prefer restoring the separately saved
pre-upgrade backup into a **different** volume. If that is unavailable, the
offline `restoreStorageMigration({ dataDir, target, masterKey })` helper in
`apps/server/dist/operations/restore-storage-migration.js` can recover the
encrypted migration archive into a new directory. This deliberately writes
legacy plaintext, refuses an existing target, validates hashes/state/history,
and does **not** include changes made after migration. Stop the server first,
secure the target and separately restore/copy the public plugin cache before
switching deployments. Never run this helper against the active volume.

## Security boundary and verification

The browser uses actual 32-byte WebAuthn PRF output and domain-separated
HKDF-SHA-256/AES-256-GCM wrapping for each storage passkey. A separately random
256-bit recovery secret wraps the same key in an independent context. PRF
output and recovery secrets never enter request JSON, logs, browser storage
or the volume. The unwrapped data key is sent directly to the server over
HTTPS after a verified WebAuthn assertion, so background work can proceed.
This is **not end-to-end encryption against the running server or TLS proxy**.

Persistent records use a separate HKDF storage key domain and fresh GCM
nonces, with vault identity and file path as authenticated context. Plaintext
records in the active encrypted stores fail closed. File names, segment dates,
sizes and public credential metadata are not hidden. A malicious trusted
plugin, compromised running server, browser, process dumps/swap, or rollback
of an entire formerly valid disk image is outside this protection.

If `APPROVAL_MCP_MASTER_KEY` remains in an environment/secret manager, it is an
intentional alternate unlock method and defeats the requirement for manual
passkey unlock. Restart without it to require a passkey. Changing it is not
key rotation and fails; this release has no automatic data-key rotation.

Run `npm run verify` and `npm run test:storage-vault-ui`. Browser verification
uses virtual PRF authenticators for migration, two providers, locked restarts,
recovery, first installation and unsupported-PRF rejection. Real Safari/iCloud
compatibility must also be checked on the deployment's stable HTTPS origin.
