ARG NODE_IMAGE=node:22-bookworm-slim
FROM golang:1.25-bookworm AS go-build
WORKDIR /build
COPY apps/workspace/api/go/go.mod apps/workspace/api/go/go.sum ./
RUN go mod download
COPY apps/workspace/api/go/*.go apps/workspace/api/go/auth.html apps/workspace/api/go/auth.css ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/bento-web-api .

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/workspace/web/package.json ./apps/workspace/web/
COPY apps/worker/package.json ./apps/worker/

FROM dependencies AS web-build
ARG VITE_BENTO_KEYCLOAK_AUTH=0
ENV VITE_BENTO_KEYCLOAK_AUTH=${VITE_BENTO_KEYCLOAK_AUTH}
RUN pnpm install --frozen-lockfile
COPY apps/workspace/web/ ./apps/workspace/web/
RUN pnpm --filter @bento/web build

FROM web-build AS api-dependencies
RUN CI=true pnpm --filter bento install --prod --offline --frozen-lockfile

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx tini \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /data
WORKDIR /app
COPY --from=go-build /out/bento-web-api /usr/local/bin/bento-web-api
COPY --from=api-dependencies /app/package.json ./package.json
COPY --from=api-dependencies /app/node_modules ./node_modules
COPY apps/workspace/api/*.ts ./apps/workspace/api/
COPY apps/workspace/auth/auth-page.ts ./apps/workspace/auth/auth-page.ts
COPY apps/orchestrator/execution-service/input.ts ./apps/orchestrator/execution-service/input.ts
COPY --from=web-build /app/apps/workspace/web/dist/ /srv/bento/
COPY deploy/workspace/nginx.conf /etc/nginx/bento.conf
COPY deploy/workspace/start.sh /usr/local/bin/bento-web
RUN chmod 755 /usr/local/bin/bento-web

ENV NODE_ENV=production \
    BENTO_ONE_MODE=http \
    BENTO_ONE_PORT=4101

USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD ["node", "-e", "Promise.all(['http://127.0.0.1:8080/', 'http://127.0.0.1:8080/api/session', 'http://127.0.0.1:4102/healthz'].map(url => fetch(url, {signal: AbortSignal.timeout(3000)}).then(async response => { await response.body?.cancel(); return response.status; }))).then(([web, api, database]) => { if (web !== 200 || api !== 401 || database !== 204) process.exitCode = 1; }).catch(() => { process.exitCode = 1; })"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bento-web"]
