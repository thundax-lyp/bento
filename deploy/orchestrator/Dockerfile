FROM golang:1.25-bookworm AS go-build
WORKDIR /build
COPY apps/orchestrator/go.mod apps/orchestrator/go.sum ./
RUN --mount=type=cache,id=bento-go-mod-1.25,target=/go/pkg/mod \
    go mod download
COPY apps/orchestrator/src/control/main.go apps/orchestrator/src/control/temporal.go apps/orchestrator/src/control/authority.go apps/orchestrator/src/control/business.go ./src/control/
RUN --mount=type=cache,id=bento-go-mod-1.25,target=/go/pkg/mod \
    --mount=type=cache,id=bento-go-build-1.25,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/bento-orchestrator ./src/control

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && install -d -o node -g node -m 0700 /data
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/orchestrator/package.json ./apps/orchestrator/
COPY apps/worker/package.json ./apps/worker/
RUN pnpm --filter @bento/orchestrator... install --prod --frozen-lockfile
COPY register-paths.mjs ./
COPY shared/text-snapshot.ts ./shared/
COPY apps/orchestrator/index.ts ./apps/orchestrator/
COPY apps/orchestrator/src/execution-service/*.ts ./apps/orchestrator/src/execution-service/
COPY apps/orchestrator/src/openshell/*.ts ./apps/orchestrator/src/openshell/
COPY apps/worker/*.ts ./apps/worker/
COPY --from=go-build /out/bento-orchestrator /usr/local/bin/bento-orchestrator
USER node
