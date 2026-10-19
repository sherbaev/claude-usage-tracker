# Claude Usage Tracker server — no npm dependencies (node:sqlite, node:http).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data TRUST_PROXY=1
COPY package.json ./
COPY plugin/package.json ./plugin/package.json
COPY plugin/scripts/core.js plugin/scripts/limits.js plugin/scripts/model-rows.js ./plugin/scripts/
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/server.js"]
