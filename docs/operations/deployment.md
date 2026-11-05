# Deployment

Approval MCP Wrapper runs as one Node.js 24 process and one writer over a
persistent data directory. The supported production shape is the supplied
container behind a TLS reverse proxy.

Required environment variables:

- `APPROVAL_MCP_PUBLIC_URL`: externally visible HTTPS origin, with no path.
- `APPROVAL_MCP_DATA_DIR`: absolute persistent directory; `/data` in the image.
- `APPROVAL_MCP_MASTER_KEY`: canonical base64 encoding of 32 random bytes.

Optional environment variables:

- `APPROVAL_MCP_PLUGINS_DIR`: absolute directory for installed presentation
  plugins; defaults to `<APPROVAL_MCP_DATA_DIR>/plugins`. With the standard
  image this is `/data/plugins`, already covered by the existing volume.
  First install needs HTTPS access to `raw.githubusercontent.com`; explicit
  update checks also use `api.github.com`. Installed plugins load offline on
  restart. No git executable, package installation, or npm scripts are used
  in the runtime container. [Plugin management](approval-plugins.md).

- `APPROVAL_MCP_OAUTH_ORIGINS`: comma-separated additional HTTPS origins where
  this same server is externally reachable for MCP and OAuth discovery. Each
  origin must have a distinct host and port; the public URL is included
  automatically. The default is only `APPROVAL_MCP_PUBLIC_URL`.
- `APPROVAL_MCP_ALLOW_INSECURE_OAUTH_PRIVATE_HTTP=true`: test-only opt-in to
  allow RFC 1918 HTTP IPv4 origins in `APPROVAL_MCP_OAUTH_ORIGINS`. Most MCP
  OAuth clients will refuse a non-TLS token endpoint, so this does not make
  private HTTP IPs usable for normal OAuth sign-in.
- `APPROVAL_MCP_VAPID_SUBJECT`: a `mailto:` address or HTTPS URL identifying
  the Web Push sender. It defaults to the public HTTPS origin. Loopback
  development uses a reserved example address.

Generate the master key with `openssl rand -base64 32`. Store it in a secret
manager. Losing it makes encrypted upstream credentials, Web Push
subscriptions, and the generated VAPID private key unrecoverable. Do not
put it in an image, Compose file, Git repository, or backup manifest.

Map persistent storage to `/data`, publish port 3000 only to the reverse proxy,
and forward the original `Host` header, including its external port. The
public URL fixes the WebAuthn RP ID and sign-in origin; changing its hostname
requires registering a new passkey. Each configured OAuth origin advertises
its own issuer and MCP resource URI. A client must use the same origin for
discovery, registration, token exchange, and MCP calls; changing its URL
requires a new authorization. The browser-based consent and passkey ceremony
always open on `APPROVAL_MCP_PUBLIC_URL`, even when the MCP client connects
through an alias. Every alias must expose `/mcp`,
`/.well-known/oauth-protected-resource/mcp`,
`/.well-known/oauth-authorization-server`, `/oauth/register`, and
`/oauth/token`. The public URL must also expose `/oauth/authorize`,
`/oauth/consent/*`, and `/api/oauth/*`. Do not cache token or consent responses.

For example, if the Mac browser signs in at `http://localhost:43127` while
clients connect through `https://approval.example.com`, set:

```text
APPROVAL_MCP_PUBLIC_URL=http://localhost:43127
APPROVAL_MCP_OAUTH_ORIGINS=https://approval.example.com
```

Both origins must reach this deployment. An alias behind a reverse proxy must
be on its allowlist and preserve the external `Host`; arbitrary inbound hosts
are rejected to prevent OAuth metadata from being forged. A private address
such as `http://192.168.64.1:43127` can only be enabled with the explicit
test-only flag above. Current MCP SDK clients reject its HTTP token endpoint;
use an HTTPS alias or a sandbox-side localhost port forward instead.

Web Push VAPID keys are generated once and persisted under `/data`; the private
key and every browser subscription are encrypted with the master key. A
production deployment must use its public HTTPS URL for notifications. On
iPhone and iPad, install the site to the Home Screen before enabling
notifications. Registered devices can be reviewed, tested individually, and
removed on the System page. A test sends a harmless notification linking to
System, without creating or deciding an approval. A successful test response
means the push provider accepted the message, not that the operating system
displayed it. Approval push payloads contain a generic alert, the approval ID,
and an internal deep link; tool arguments and plugin presentation data remain
on the server.

The image runs as the unprivileged `node` user. Use a read-only root filesystem
with `/data` as its writable volume. Probe `/health/live` for liveness and
`/health/ready` for readiness. Individual upstream failures are visible in the
admin UI but do not make the wrapper globally unready.

Upstream tool catalogs are checked every 30 seconds while the server runs.
Changes also become visible immediately when an administrator uses **Discover
tools** in Upstreams or Profiles. The server notifies subscribed modern MCP
clients when the catalog or profile visibility changes. Older clients that do
not subscribe to tool-list changes may still need to re-list tools or reconnect;
restarting Approval MCP itself is not required. Newly discovered tools follow
the existing profile rules: a server-wide rule applies automatically, while
an otherwise unconfigured tool stays hidden until it is configured in
**Access → Profiles**.
