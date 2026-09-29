FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="MS365 MCP Container"
LABEL org.opencontainers.image.description="Community-maintained container distribution for @softeria/ms-365-mcp-server"
LABEL org.opencontainers.image.source="https://github.com/X1pheR/ms365-mcp"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.revision="${REVISION}"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force
COPY src ./src

ENTRYPOINT ["node", "/app/src/entrypoint.mjs"]
