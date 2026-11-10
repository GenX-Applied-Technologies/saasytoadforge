# SaaSyToad Forge agent-service: long-running Fastify WebSocket server.
# Build context MUST be the repo root (it needs packages/shared and the workspace lockfile):
#   docker build -f apps/agent-service/Dockerfile --build-arg FORGE_BUILD_SHA=$(git rev-parse HEAD) -t forge-agent .
FROM node:22-slim

# pnpm via corepack, pinned to the workspace version. Only used at build time.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy workspace manifests first so the install layer caches well. All package.json files
# are needed for pnpm to resolve the workspace; the filter limits what actually installs.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/agent-service/package.json ./apps/agent-service/
COPY apps/web/package.json ./apps/web/

# Install only the agent-service and its workspace dependencies (keeps the image lean).
# NODE_ENV is intentionally unset here so devDependencies (tsx) are installed.
RUN pnpm install --frozen-lockfile --filter "@forge/agent-service..."

# Source for the agent-service and its shared package.
COPY packages/shared ./packages/shared
COPY apps/agent-service ./apps/agent-service
RUN chmod 0755 /app/apps/agent-service/docker-entrypoint.sh

# The commit this image was built from; /health reports it so a walkthrough can confirm the build.
ARG FORGE_BUILD_SHA
ENV FORGE_BUILD_SHA=${FORGE_BUILD_SHA}
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# The server runs as the unprivileged `node` user. The entrypoint starts as root only to hand
# a root-owned Fly volume (FORGE_DATA_DIR) to that user, then drops all privileges.
WORKDIR /app/apps/agent-service
HEALTHCHECK --interval=30s --timeout=3s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/apps/agent-service/docker-entrypoint.sh"]
# tsx runs the TypeScript entry directly; the server binds 0.0.0.0 and drains on SIGTERM.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
