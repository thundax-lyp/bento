FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json ./apps/worker/
RUN pnpm --filter @bento/worker install --prod --frozen-lockfile
COPY register-paths.mjs source-aliases.mjs tsconfig.json ./
COPY apps/worker/src/ ./apps/worker/src/
WORKDIR /app/apps/worker
USER node
ENTRYPOINT ["node", "--import", "/app/register-paths.mjs", "src/run-worker.ts"]
