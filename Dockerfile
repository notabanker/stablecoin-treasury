FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services

ENV NODE_ENV=production
RUN mkdir -p /data && chown -R node:node /app /data
USER node

CMD ["node", "services/api-gateway/src/index.mjs"]
