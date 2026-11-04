# Initial Runtime Package Admission

Assessment date: 2026-10-09

## @modelcontextprotocol/client@2.3.1

- Release: 2026-10-05; stable SDK v2 split package.
- Adoption: 6.59 million npm downloads in 2026-10-01 through 2026-10-07.
- Maintainers: active official Model Context Protocol TypeScript SDK repository; five npm maintainers.
- Direct runtime dependencies: seven, including the exact matching core package.
- License: Apache-2.0.
- Security: upgrades past [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h); OSV reports no advisory for this version, and the lockfile npm audit reports no runtime advisory at admission.
- Rationale: official MCP client, Streamable HTTP transport, and automatic
  legacy/modern protocol negotiation for upstream connections; Node built-ins do not implement MCP.

## @modelcontextprotocol/core@2.3.1

- Release: 2026-10-05; stable SDK v2 split package.
- Adoption: 11.74 million npm downloads in 2026-10-01 through 2026-10-07.
- Maintainers: active official Model Context Protocol TypeScript SDK repository; five npm maintainers.
- Direct runtime dependencies: one (Zod).
- License: Apache-2.0.
- Security: paired with patched client 2.3.1; OSV reports no advisory for this version, and the lockfile npm audit reports no runtime advisory at admission.
- Rationale: shared official MCP wire types and validation used by the client,
  server, and Node adapter; Node built-ins do not implement MCP schemas.

## @modelcontextprotocol/node@2.1.1

- Release: 2026-10-02; stable SDK v2 split package.
- Adoption: 2.71 million npm downloads in 2026-10-01 through 2026-10-07.
- Maintainers: active official Model Context Protocol TypeScript SDK repository; five npm maintainers.
- Direct runtime dependencies: two plus peer dependency on the MCP server.
- License: Apache-2.0.
- Security: OSV reports no advisory for this version, and the lockfile npm audit reports no runtime advisory at admission.
- Rationale: official adapter between Node HTTP requests and the web-standard
  dual-era MCP handler; Node built-ins do not provide that handler.

## @modelcontextprotocol/server@2.3.1

- Release: 2026-10-05; stable SDK v2 split package.
- Adoption: 9.53 million npm downloads in 2026-10-01 through 2026-10-07.
- Maintainers: active official Model Context Protocol TypeScript SDK repository; six npm maintainers.
- Direct runtime dependencies: two, including the exact matching core package.
- License: Apache-2.0.
- Security: OSV reports no advisory for this version, and the lockfile npm audit reports no runtime advisory at admission.
- Rationale: official MCP server and dual-era HTTP handler supporting both the
  2025-11-25 and 2026-07-28 protocol generations; Node built-ins do not implement MCP.

## fastify@5.12.5

- Latest release: 2026-09-16.
- Adoption: approximately 10 million weekly downloads and more than 5,000 dependents.
- Maintainers: active OpenJS Foundation project with multiple maintainers.
- Runtime dependencies: 15.
- License: MIT.
- Security: must pass the lockfile npm audit and CI advisory gate before merge.
- Rationale: maintained HTTP framework with schema validation, injection testing, lifecycle hooks, and streaming support.

## @fastify/static@10.1.9

- Security update assessed: 2026-11-04; replaces 10.1.2.
- Release: 2026-11-04.
- Adoption: 8,502,347 npm downloads in 2026-10-28 through 2026-11-03.
- Maintainers: official Fastify organization.
- Runtime dependencies: seven; remains compatible with Fastify 5 and Node 24.
- License: MIT.
- Security: lockfile resolves glob 14.0.3 and minimatch 11.0.4, addressing
  [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)
  and [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
  OSV reports no advisory for this version, and the production npm audit no
  longer reports these packages. Must pass the CI advisory gate before merge.
- Rationale: safely serves the production Vite assets through the same Fastify process.

## zod@4.6.7

- Security update assessed: 2026-11-04; replaces 4.4.3 across all workspaces.
- Release: 2026-10-12.
- Adoption: 450,642,092 npm downloads in 2026-10-28 through 2026-11-03.
- Maintainers: active project with a stable v4 release line.
- Runtime dependencies: zero.
- License: MIT.
- Security: upgrades past the affected range of
  [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
  OSV reports no advisory for this version, and the production npm audit no
  longer reports Zod. Must pass the CI advisory gate before merge.
- Rationale: required by the official MCP SDK and used for boundary validation.

## @simplewebauthn/server@13.3.2

- Latest release: 2026-06.
- Adoption: approximately 2.1 million weekly downloads and more than 300 dependents.
- Maintainers: active SimpleWebAuthn project.
- Runtime dependencies: eight.
- License: MIT.
- Security: must pass the lockfile npm audit and CI advisory gate before merge.
- Rationale: standards-sensitive WebAuthn verification is not appropriate to reimplement.

## @simplewebauthn/browser@13.3.0

- Latest release: 13.3.0; server and browser packages use independent release versions.
- Adoption: established browser companion to the server package.
- Maintainers: active SimpleWebAuthn project.
- Runtime dependencies: verified from the installed lockfile during admission.
- License: MIT.
- Security: must pass the lockfile npm audit and CI advisory gate before merge.
- Rationale: normalizes browser WebAuthn ceremony encoding and error handling.

## react@19.2.8

- Latest release: 2026-07-21.
- Adoption: more than 135 million weekly downloads and more than 200,000 dependents.
- Maintainers: Meta React team.
- Runtime dependencies: zero.
- License: MIT.
- Security: must pass the lockfile npm audit and CI advisory gate before merge.
- Rationale: accessible, stateful administration and approval UI.

## react-dom@19.2.8

- Latest release: aligned with React 19.2.8.
- Adoption: core React browser renderer with ecosystem-scale usage.
- Maintainers: Meta React team.
- Runtime dependencies: verified from the installed lockfile during admission.
- License: MIT.
- Security: must pass the lockfile npm audit and CI advisory gate before merge.
- Rationale: required to render the React web application.
