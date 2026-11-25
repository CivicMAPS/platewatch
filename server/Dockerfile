# syntax=docker/dockerfile:1.7
# PlateWatch backend + the built PWA and the console, one origin. Build from the repository root:
#   docker build -f server/Dockerfile -t platewatch-server .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Optional build secret "ca" (a proxy's CA bundle) for networks that re-sign TLS; absent normally.
RUN --mount=type=secret,id=ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/ca npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm run server:build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# The server is one bundle; its only runtime dependency is pg (server/runtime-package.json).
COPY server/runtime-package.json ./package.json
RUN --mount=type=secret,id=ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/ca npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist ./dist
COPY server/console ./dist-server/console
COPY src/styles/civicmaps ./dist-server/civicmaps
# Amazon RDS certificate authorities (used when PLATEWATCH_DB_CA_FILE points here).
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-ca.pem
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist-server/server.mjs"]
