FROM golang:1.25-bookworm AS go-build
WORKDIR /build
COPY apps/orchestrator/orchestrator-control/go.mod apps/orchestrator/orchestrator-control/go.sum ./
RUN --mount=type=cache,id=bento-go-mod-1.25,target=/go/pkg/mod \
    go mod download
COPY apps/orchestrator/orchestrator-control/cmd/control/ ./cmd/control/
COPY apps/orchestrator/orchestrator-control/internal/ledger/ ./internal/ledger/
RUN --mount=type=cache,id=bento-go-mod-1.25,target=/go/pkg/mod \
    --mount=type=cache,id=bento-go-build-1.25,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/bento-orchestrator ./cmd/control

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && install -d -o node -g node -m 0700 /data
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/orchestrator/orchestrator-execution-host/package.json ./apps/orchestrator/orchestrator-execution-host/
COPY apps/worker/package.json ./apps/worker/
RUN pnpm --filter @bento/orchestrator... install --prod --frozen-lockfile
COPY register-paths.mjs source-aliases.mjs tsconfig.json ./
COPY shared/text-snapshot.ts ./shared/
COPY apps/orchestrator/orchestrator-execution-host/src/index.ts ./apps/orchestrator/orchestrator-execution-host/src/
COPY apps/orchestrator/orchestrator-execution-host/src/execution-service/*.ts ./apps/orchestrator/orchestrator-execution-host/src/execution-service/
COPY apps/orchestrator/orchestrator-execution-host/src/execution-service/store/*.ts ./apps/orchestrator/orchestrator-execution-host/src/execution-service/store/
COPY apps/orchestrator/orchestrator-execution-host/src/openshell/*.ts ./apps/orchestrator/orchestrator-execution-host/src/openshell/
COPY apps/worker/src/ ./apps/worker/src/
COPY --from=go-build /out/bento-orchestrator /usr/local/bin/bento-orchestrator
USER node
