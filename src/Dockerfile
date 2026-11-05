FROM node:22.14.0-alpine3.21 AS frontend-builder

WORKDIR /web
RUN corepack enable && corepack prepare pnpm@10.6.2 --activate

COPY web/package.json web/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY web/ ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm build

FROM golang:1.25.2-alpine3.21 AS backend-builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend-builder /web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o server .

FROM gcr.io/distroless/static-debian12:nonroot AS final

ENV PORT=8080
EXPOSE 8080
USER nonroot:nonroot
WORKDIR /app
COPY --from=backend-builder /app/server /app/server
COPY --from=backend-builder /app/web/dist /app/web/dist
ENTRYPOINT ["/app/server"]
