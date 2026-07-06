FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY apps ./apps
COPY packages ./packages
COPY services ./services
COPY db ./db
COPY scripts ./scripts

ENV NODE_ENV=production

# Non-root user already applied (USER node below).
# Read-only root filesystem: mount tmpfs for writable paths.
# Capabilities: drop all, keep only what Node needs (none beyond defaults).
RUN chown -R node:node /app && \
    mkdir -p /tmp && chown node:node /tmp

USER node

# HEALTHCHECK tuned for production: the gateway /health endpoint confirms
# both the HTTP server and database connectivity.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health',r=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "services/api-gateway/src/index.mjs"]
