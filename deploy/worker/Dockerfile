FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json ./apps/worker/
RUN pnpm --filter @bento/worker install --prod --frozen-lockfile
COPY apps/worker/*.ts ./apps/worker/
WORKDIR /app/apps/worker
USER node
ENTRYPOINT ["node", "run-worker.ts"]
