FROM golang:1.25-bookworm AS go-build
WORKDIR /build
COPY apps/orchestrator/go.mod apps/orchestrator/go.sum ./
RUN go mod download
COPY apps/orchestrator/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/bento-orchestrator .

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
COPY apps/orchestrator/execution-service/*.ts ./apps/orchestrator/execution-service/
COPY apps/orchestrator/openshell/*.ts ./apps/orchestrator/openshell/
COPY apps/worker/*.ts ./apps/worker/
COPY --from=go-build /out/bento-orchestrator /usr/local/bin/bento-orchestrator
USER node
