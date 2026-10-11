# ReviewQR - no native modules, so a plain Alpine image is enough.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/reviewqr.db

WORKDIR /app

# Install dependencies first so this layer is cached between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The SQLite file lives on a volume so it survives a redeploy.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
