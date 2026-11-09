FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN npm ci --ignore-scripts \
  && npm run build \
  && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    APPROVAL_MCP_DATA_DIR=/data

# Presentation plugins are downloaded at runtime into /data/plugins, not baked
# into this image. The existing /data volume persists them across replacements.

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
# Explicit fixtures used by CI and optional verification; not executed on startup.
COPY --from=build --chown=node:node /app/scripts/plugin-fixtures.mjs ./scripts/plugin-fixtures.mjs
# Declarative upstream setup CLI: docker exec -i <container> approval-mcp-setup < .approval-mcp.json
COPY --from=build --chown=node:node /app/scripts/approval-mcp-setup.mjs ./scripts/approval-mcp-setup.mjs
COPY --from=build --chmod=0755 /app/scripts/container/approval-mcp-setup /usr/local/bin/approval-mcp-setup

RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "apps/server/dist/main.js"]
