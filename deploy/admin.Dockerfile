FROM golang:1.25-bookworm AS build
WORKDIR /build
COPY apps/admin/admin-api/go.mod apps/admin/admin-api/go.sum ./
RUN go mod download
COPY apps/admin/admin-api/cmd/admin-api/main.go ./cmd/admin-api/
RUN CGO_ENABLED=0 go build -trimpath -o /out/bento-admin ./cmd/admin-api

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/bento-admin /usr/local/bin/bento-admin
COPY apps/admin/admin-auth/src/ /app/auth/
COPY apps/admin/admin-web/src/ /app/web/
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/bento-admin"]
