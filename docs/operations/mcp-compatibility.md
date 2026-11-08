# MCP Compatibility

The public `/mcp` endpoint accepts both protocol generations supported by the
stable TypeScript SDK v2:

- legacy MCP through the 2025-11-25 Streamable HTTP lifecycle;
- modern MCP 2026-07-28 through `server/discover` and typed modern requests.

The endpoint keeps the same bearer-token authentication, validation of Origin
when a client supplies that header,
token-scoped tool catalog, policy checks, approval flow, and audit records in
both modes. Upstream connections use automatic negotiation: they try the modern
discovery flow first and fall back to the legacy lifecycle when the upstream is
not modern-capable.

## Browser-based OAuth sign-in

New clients can connect to the public `https://<your-host>/mcp` URL without a
manually created agent token. An unauthenticated request receives an OAuth
protected-resource challenge. The server advertises authorization-server
metadata and supports dynamic registration of public clients, authorization
code with S256 PKCE, and rotating refresh tokens. A browser opens the consent
page; after passkey sign-in, the administrator sees the unverified client name,
client ID and exact callback URL, assigns a recognizable agent name, chooses
one access profile and a lifetime between one hour and thirty days, and
confirms with the passkey again. Denying
the request returns an OAuth error to the client. There is no Device Flow.

The resulting agent appears in **Access → Agents**, labelled OAuth, with its
expiry. Delete it there to revoke access immediately. Changing its chosen
profile requires revocation and another sign-in. OAuth clients cannot receive
the MCP management permission or a manually rotated token. Existing manually
created `amcp_` agent tokens continue to work. OAuth changes *how* the client
obtains a token; MCP HTTP requests still carry a short-lived
`Authorization: Bearer` access token. Individual tool approvals continue to
apply to the selected profile.

The server writes one structured `oauth.refresh` line to container logs for
each refresh attempt with a recognized token. Unknown tokens are not logged to
avoid log flooding. Each line records the outcome, a reason for rejection, the
grant and agent IDs when known, and the grant expiry after a successful refresh.
It never logs access or refresh token values. `grant_expired` means the
approved access lifetime ended.

Refresh rotation has a **30-minute reuse tolerance**, measured from a token's
**first** successful use. Retries do not slide that deadline forward. A repeated
request within that window, including a recent ancestor of the latest token,
receives the latest valid token pair rather than revoking the grant or creating
an independent token branch. This handles concurrent client processes and a
lost refresh response. The returned `expires_in` is recomputed from the actual
stored access expiry; the access token lifetime remains 15 minutes and consent
expiry is never extended. If the cached access token expired, one new canonical
pair is issued and the previous active refresh token is marked used.

The current response is cached **encrypted**, bound to its grant. Production
uses the persistent storage codec, so an unlocked server can recover that
response after restart. Raw access/refresh token strings are not stored in the
state. Older grants without cache/generation metadata are upgraded lazily on
refresh; no new login is needed for still-active grants. Previously revoked
grants remain revoked and require a new authorization.

Diagnostics report `outcome: reused` and `reason: reuse_within_grace` for a
cached response, or `outcome: issued` with the same reason when it had to be
renewed. Safe metadata includes `usedAgoMs`, `tokenGeneration`,
`currentGeneration` and `isLatestParent` when available; unknown legacy
generations are omitted. A used token presented **at or beyond 30 minutes**
still causes `replay_detected`, grant revocation and a new authorization.
Client/issuer/resource binding, grant expiry, profile changes, administrator
revocation and agent deletion are checked before any tolerance is applied.

This window is an explicit usability/security trade-off: a stolen used token
can obtain the current credentials within that window too. It is not a period
specified by [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2).
Do not treat a tolerated retry as proof of the client's identity beyond its
existing token/binding checks. A process holding a consumed token for longer
than 30 minutes still needs coordinated credential refresh or a separate
authorization; the tolerance does not solve indefinitely stale client caches.

The callback must be reachable by the browser that completes the sign-in.
`http://localhost` and other loopback callback URLs refer to that browser's
machine, which matters if the sandbox runs on another host. HTTPS callbacks
are also accepted. This implementation supports Dynamic Client Registration;
clients that only support Client ID Metadata Documents are not yet compatible.
Multiple explicitly configured MCP origins are supported; the authorization
page remains on the public passkey origin, while discovery, registration,
tokens, and MCP requests use the client's chosen origin. Access tokens are
bound to that origin. MCP OAuth clients generally require HTTPS for any
non-loopback token endpoint, including a private network IP; see the
[deployment settings](deployment.md) before connecting from a sandbox.

The approval wait remains a normal blocking `tools/call` response. MCP Tasks are
not advertised. In protocol 2026-07-28, Tasks moved to the experimental
`io.modelcontextprotocol/tasks` extension, and no production TypeScript
extension package is currently published. The existing approval coordinator is
kept independent from the transport so a standard Tasks adapter can be added
when the official extension surface is available. Until then, advertising a
private look-alike would create incompatible clients and is intentionally
avoided.

Compatibility is covered by integration tests that connect one legacy client
and one auto-negotiating modern client to the same authenticated gateway and
exercise tool listing, inspection, allowed calls, and denied calls.

## Approval MCP's own tools

The profile editor shows a virtual **Approval MCP** upstream. Its tool rules
apply through the same policy, approval, and audit flow as external tools. The
available names are `approval_mcp__inspect_tool`, `approval_mcp__list_upstreams`,
`approval_mcp__get_tool_info`, `approval_mcp__list_history`,
`approval_mcp__get_history_event`, `approval_mcp__list_all_history`,
`approval_mcp__get_any_history_event`, `approval_mcp__get_upstream_health`, and
`approval_mcp__refresh_upstream_tools`. There is no approval-status polling tool:
an approval waits in its original call.

Only `inspect_tool` retains its historical default availability when no
profile rule exists. Other self tools are hidden until configured in a profile.
The ordinary history tools restrict results to the authenticated MCP token;
knowing another call ID does not grant access. The separate `list_all_history`
and `get_any_history_event` tools can read redacted history across agents. They,
like the health and refresh tools, require both an explicit profile rule and
the agent's **MCP management** permission. History pages use stable
first-seen-time cursors; a cursor is valid only with the filters that produced it.
This permission can be set when creating an agent or changed later in its
settings without changing its token. Management tokens should be kept separate
from ordinary agent tokens and rotated or deleted when no longer needed. A
rotated token keeps the agent's profiles but immediately invalidates the old
secret; deleting an agent also removes its active grants and profile assignments
while retaining its identity in audit history. No self tool can approve or
change a profile rule.
