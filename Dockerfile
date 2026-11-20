# Fitness app image, built in CI (never on the VPS). Same layout as AaryaShree IMS.
# Debian slim (glibc): the argon2 native module ships prebuilt glibc binaries.
FROM node:24-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild esbuild

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:24-trixie-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 && mkdir -p /media /status && chown node:node /media
COPY --from=build /app/dist ./dist
# Challenge settings files (e.g. Calamari) for the server CLI: node dist/src/cli.js create-challenge ...
COPY config ./config
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# App: node dist/src/server.js | Migrations: node dist/src/db/migrate.js | CLI: node dist/src/cli.js <command>
CMD ["node", "dist/src/server.js"]
