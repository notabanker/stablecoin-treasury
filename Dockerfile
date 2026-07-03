FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY apps ./apps
COPY packages ./packages
COPY services ./services
COPY db ./db

ENV NODE_ENV=production
RUN chown -R node:node /app
USER node

CMD ["node", "services/api-gateway/src/index.mjs"]
