ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/

FROM dependencies AS web-build
RUN pnpm install --frozen-lockfile
COPY apps/web/ ./apps/web/
RUN pnpm --filter @bento/web build

FROM web-build AS api-dependencies
RUN CI=true pnpm --filter bento install --prod --offline --frozen-lockfile

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx tini \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /data
WORKDIR /app
COPY --from=api-dependencies /app/package.json ./package.json
COPY --from=api-dependencies /app/node_modules ./node_modules
COPY src/task-entry/ ./src/task-entry/
COPY src/execution-service/input.ts ./src/execution-service/input.ts
COPY --from=web-build /app/apps/web/dist/ /srv/bento/
COPY deploy/web/nginx.conf /etc/nginx/bento.conf
COPY --chmod=755 deploy/web/start.sh /usr/local/bin/bento-web

ENV NODE_ENV=production \
    BENTO_ONE_MODE=http \
    BENTO_ONE_PORT=4101

USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD ["node", "-e", "Promise.all(['/', '/api/session'].map(path => fetch('http://127.0.0.1:8080' + path, {signal: AbortSignal.timeout(3000)}).then(async response => { await response.body?.cancel(); return response.status; }))).then(([web, api]) => { if (web !== 200 || api !== 401) process.exitCode = 1; }).catch(() => { process.exitCode = 1; })"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bento-web"]
