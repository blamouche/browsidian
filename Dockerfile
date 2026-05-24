# syntax=docker/dockerfile:1.7

FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; \
    else npm install --omit=dev --no-audit --no-fund; fi

COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173

USER node

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/config" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
