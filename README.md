# Approval MCP

An approval gateway between AI agents and your MCP servers. Decide which
tools an agent can use directly, which require human approval, and which are
blocked. Review decisions, active permissions, and call history in the web app.

```text
MCP client → Approval MCP → your MCP servers
                  ↕
           web-based approval
           + push notifications
```

## Demo

[![Approve an entire tool for one hour](docs/media/approval-mcp-demo.png)](docs/media/approval-mcp-demo.webm)

[Watch the short demo (WebM)](docs/media/approval-mcp-demo.webm)

The video covers upstreams, profiles, message approval, one-hour tool-wide
permission without recipient restrictions, history, notification devices, and
adding presentation plugins from your own repositories.
It uses sample data only: no real WhatsApp messages or push notifications are
sent. [Demo script and recording instructions](docs/demo.md).

## Features

- **Encrypted storage:** configuration and call history are encrypted on disk.
  Keep the existing environment key for automatic startup unlock, or register
  storage passkeys and require unlock after restart. Locked startup can notify
  your registered devices. [Migration and security boundaries](docs/operations/encrypted-storage.md).
- **Access profiles:** allow, require approval, or deny access to an entire
  upstream or individual tools. Unconfigured tools stay hidden.
- **Readable approvals:** plugins show the message, contact, chat, event, or
  booking involved. Expand the technical arguments when needed.
- **Independent plugins:** install, check for updates, enable, or uninstall
  presentation plugins in **Plugins**. Add your own public GitHub repository,
  review its pinned version and explicitly trust its code. There is no fixed
  catalog or automatic installation. Code is cached in the persistent volume.
- **Temporary permissions:** approve once, approve a specific scope, or allow
  the entire tool with any arguments for one hour. Permanent grants are
  available for supported scopes. Active grants can be revoked at any time.
- **OAuth and passkeys:** the client opens an authorization page where you
  choose an agent name, profile, and access lifetime, then confirm with your
  passkey. Manually created agent tokens are also supported.
  Refresh-token rotation tolerates reuse for 30 minutes from first use, so
  concurrent client processes can converge without revoking each other's access.
  [Behavior and security trade-off](docs/operations/mcp-compatibility.md).
- **Web Push:** notifications link to the approval detail. Manage registered
  devices, send individual tests, and remove devices from the web app.
- **History:** call timelines, decisions, denial reasons, and JSONL/CSV export.
- **Live tool catalog:** refresh tools while the server runs, without restarting.
- **English and Czech UI**, light and dark themes, and a mobile layout.

## Docker quick start

You need Docker and a browser with passkey support. For your first local run,
use `http://localhost:43127`. Remote deployments should use HTTPS.

```bash
git clone https://github.com/jiridudekusy/approval-mcp-wrapper.git
cd approval-mcp-wrapper
cp .env.example .env
openssl rand -base64 32
```

Paste the generated key into `.env` as `APPROVAL_MCP_MASTER_KEY`. Keep the
same key for subsequent runs: it encrypts storage, upstream credentials and Web Push
data. Keep `.env` out of Git.

```bash
docker build -t approval-mcp-wrapper:local .
docker volume create approval-mcp-data
docker run -d \
  --name approval-mcp \
  --restart unless-stopped \
  --env-file .env \
  --publish 127.0.0.1:43127:3000 \
  --mount source=approval-mcp-data,target=/data \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  approval-mcp-wrapper:local
```

Open [localhost:43127](http://localhost:43127) and continue with a passkey.
The first sign-in creates the administrator. Passkeys are bound to the sign-in
hostname, so choose a stable server address for ongoing use.

The `approval-mcp-data` volume and the same master key preserve settings,
active grants, and push device registrations when replacing the image. Keep
the data volume during upgrades. Installed plugins are preserved there too,
under `/data/plugins`; your existing `/data` mount is sufficient. Adding a
repository and checking updates require HTTPS to `api.github.com`; code and
manifests are downloaded from `raw.githubusercontent.com`. Later restarts use
the local cache without GitHub requests. A fresh server starts with no plugins.
Pending calls are interrupted by a restart.

After a successful CI pipeline, the image is also published as
`ghcr.io/jiridudekusy/approval-mcp-wrapper:latest` for `linux/amd64` and
`linux/arm64`. The registry image may not include unpublished local commits;
the build above uses your current checkout.

## Initial setup

1. In **Upstreams**, add your MCP server's Streamable HTTP URL. Set its alias,
   display name, description, optional credentials, and presentation plugin.
   Metadata can distinguish work and personal email accounts, for example.
   For a specialized presentation, first use **Plugins → Add plugin** to add
   its repository, preview the exact commit, and confirm that you trust its code.
2. Select **Discover tools**. Enable private network access when intentionally
   connecting to a local or private network address.
3. Configure rules in **Access → Profiles**. Start with read-only tools and
   use **Require approval** for sensitive operations. Set the approval wait
   timeout and tool execution timeout independently in the same profile;
   both default to 60 seconds.
4. Connect an MCP client through OAuth, or create an agent in **Access** and
   copy its token, which is displayed only once.
5. Calls requiring approval appear in **Inbox** and are recorded in
   **History**. Enable notifications in **System**.

### Connect an MCP client

For OAuth, give your client the HTTP MCP endpoint without a manual token:

```json
{
  "mcpServers": {
    "approval": {
      "type": "http",
      "url": "http://localhost:43127/mcp"
    }
  }
}
```

The exact configuration format depends on the client. During browser
authorization, choose a profile, agent name, and access lifetime. Client
sign-in does not automatically approve individual tool calls.

For a manually created agent, add the HTTP header
`Authorization: Bearer <agent-token>`. Keep the token out of public
configuration files and logs.

`localhost` refers to the client's own machine or container. If your agent
runs elsewhere, use a reachable HTTPS server address and configure the
corresponding OAuth origin. The OAuth callback must be reachable from the
machine running the sign-in browser.
[Multiple addresses and reverse proxies](docs/operations/deployment.md).

### One hour without scope restrictions

In the approval detail, select **Whole tool (any arguments)**, then
**Allow for 1 hour**. The grant applies to the same agent, upstream, and tool,
with no restriction on the chat, recipient, or other arguments. This also
works for plugins that propose no reusable scope. After expiry, approval is
required again. Revoke it earlier in **Access → Active permissions**.

Explicit denies and profile-based tool visibility still apply. This option
does not offer an unrestricted permanent grant.

### Notifications

In **System**, name your device and enable notifications. Send a test to any
registered device or remove it. Clicking a notification opens the request
detail; decisions are made in the authenticated web app.

Use a stable HTTPS address for remote access. On iOS/iPadOS, add the site to
the Home Screen and enable notifications from the installed web app. Push
payloads contain a generic alert, an ID, and a link; tool arguments and
message contents are not included. Notification display and available system
actions depend on the device and browser.

## Declarative upstream setup

A project can declare the upstreams it needs in `.approval-mcp.json` and
submit that declaration with one command. The wrapper computes a plan
(create, update, or unchanged per upstream), and nothing changes until an
admin approves the plan with a passkey.

```json
{
  "source": "my-agent-workspace",
  "upstreams": [
    {
      "alias": "jira",
      "url": "https://jira-mcp.example.com/mcp",
      "displayName": "Jira",
      "credentialsRequired": true,
      "credentials": { "authorization": { "env": "JIRA_MCP_TOKEN", "prefix": "Bearer " } }
    }
  ]
}
```

The file is safe to commit because it holds no secrets: credentials must be
`{ "env": "VARIABLE", "prefix"?: "..." }` references, and literal values are
rejected. Each upstream also accepts `description`, `metadata`, and
`allowPrivateNetwork`. Fields left out keep their current value. A
presentation plugin is assigned in the admin UI, and setup keeps it.
`source` is a self-reported name and is shown as unverified.

The CLI ships in the wrapper image, so the project needs nothing installed.
From the project directory, pipe the file into the running container (named
`approval-mcp` in the quick start above):

```bash
docker exec -i approval-mcp approval-mcp-setup < .approval-mcp.json
```

Pass referenced variables from your shell with `-e` (no value copies it from
the host), or leave them out and enter the `Authorization` value on the
approval page:

```bash
docker exec -i -e JIRA_MCP_TOKEN approval-mcp approval-mcp-setup < .approval-mcp.json
```

Inside the container the CLI calls the server's `APPROVAL_MCP_PUBLIC_URL`,
because the server accepts only requests addressed to its configured hosts.
If that URL is not reachable from inside the container, pass
`-e APPROVAL_MCP_URL=<reachable URL with an allowed host>`.
Add `--timeout <seconds>` to change how long it waits for approval (default
15 minutes). The exit code is `0` when the changes were applied or already
up to date, and `1` otherwise.

Without Docker, run the same CLI from a checkout of this repository:
`node scripts/approval-mcp-setup.mjs [--file .approval-mcp.json] [--server URL] [--timeout seconds]`.
The server address is taken from `--server`, then `APPROVAL_MCP_URL`, then
an optional `server` field in the file, and defaults to
`http://localhost:3000`.

The flow:

1. The CLI resolves credentials from environment variables and submits the
   declaration. If everything already matches, it exits immediately, so
   repeated runs do nothing.
2. Otherwise it prints an approval link. Sign in to the web app and open it to
   review every value that will be stored. Changed values are marked, and an
   address change also shows the address it replaces.
3. If the `Authorization` variable is not set, the CLI asks for that credential on
   the approval page instead. The page only collects the `Authorization`
   header, so the CLI refuses to submit an upstream with custom `headers`
   unless all of its variables are set.
4. Confirm with your passkey. The CLI reports the result.

Safety rules:

- Upstreams are matched by alias. A repeated declaration never creates a
  duplicate, and an alias used by two existing upstreams is rejected.
- Nothing is deleted. Upstreams missing from the declaration stay as they are.
- Stored credentials never move to a changed URL. They are removed, or the
  approval page asks for new ones when the declaration requires them.
- Approval is bound to the plan that was shown. If the upstreams changed in
  the meantime, approval fails and the request is dropped; run the CLI again.
- Pending requests are kept in memory only, expire after 15 minutes, and at
  most 10 can be pending. Credentials of a request that is never approved
  never reach the disk, and a server restart drops pending requests. Approved
  credentials are stored encrypted like any other upstream credentials.
  Credentials are never returned by any endpoint or printed by the CLI.
- Changed upstreams are marked with the requesting `source` (`managedBy`).

New upstreams expose no tools until you add rules in **Access → Profiles**.
Profile rules are not part of the declaration yet.

The submit endpoint (`POST /api/setup/requests`) is unauthenticated by design
so that a local tool can call it. Keep the server on loopback or behind HTTPS.
Every change still requires the admin's passkey.

## Run locally without Docker

You need Node.js 24 and npm. Use the same `.env` as in the quick start.

```bash
npm ci
npm run build
mkdir -p .local-data
HOST=127.0.0.1 PORT=43127 \
APPROVAL_MCP_DATA_DIR="$PWD/.local-data" \
node --env-file=.env apps/server/dist/main.js
```

The web app and MCP endpoint share the same port. Run `npm run verify` to
check changes: type checking, tests, production build, runtime dependency
audit, and language catalog validation.

A harmless test upstream is available in
[pocs/approval-test-mcp](pocs/approval-test-mcp/README.md). Its deployment
tool only simulates a deployment.

## Operations and documentation

| Topic | Documentation |
| --- | --- |
| HTTPS, configuration, OAuth origins, persistent data | [Deployment](docs/operations/deployment.md) |
| Backups and data migration | [Backup and restore](docs/operations/backup-and-restore.md) |
| Recovering data after a failure | [Disaster recovery](docs/operations/disaster-recovery.md) |
| Protocol support, OAuth, and built-in MCP tools | [MCP compatibility](docs/operations/mcp-compatibility.md) |
| Presentation plugins and their behavior | [Plugins](docs/operations/approval-plugins.md) |
| Encrypted storage, passkey unlock, migration, startup notifications | [Encrypted storage](docs/operations/encrypted-storage.md) |
| Experimental passkey-derived storage encryption | [Isolated vault PoC](docs/operations/passkey-vault-poc.md) |

Health endpoints are `/health/live` and `/health/ready`. The supported
deployment runs one writer over a single data directory. MCP Tasks are not
advertised yet; approval waits in the original tool call.

## Project structure

```text
apps/server       HTTP server, authentication, OAuth, admin API, Web Push
apps/web          React UI
packages/gateway  MCP gateway and approval workflow
packages/policy   rules, profiles, and permission evaluation
packages/*        contracts, state store, audit journal, upstream client, plugin SDK
pocs/             standalone experiments and a test MCP server
examples/         isolated passkey-derived encryption proof of concept
```
