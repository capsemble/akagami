# ---- build ----------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# --ignore-scripts: the root postinstall builds shared, which needs the sources.
RUN npm ci --ignore-scripts || npm install --ignore-scripts

COPY . .
RUN npm run build

# ---- run ------------------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
RUN npm install --omit=dev --workspace @chapter-quest/server --ignore-scripts

COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY mocks mocks
# The prepared world the pipeline falls back to; without it a failed build
# had nothing to stand in.
COPY server/fixtures server/fixtures
# Worlds built before deploying — scripts, painted art, cached Oracle runs —
# so the deployed app opens on the curated demo worlds rather than an empty
# library. Anything built on Cloud Run lands beside them, until the next deploy.
COPY server/.cache server/.cache
# The library lists newest first by file time, and the shipped worlds arrive
# with times hours ahead of the server clock, so a world built on Cloud Run
# sorted below all of them and looked unsaved. Push every shipped file back a
# week, keeping their order among themselves.
RUN find server/.cache -type f -exec sh -c 'for f; do touch -m -d "@$(( $(stat -c %Y "$f") - 604800 ))" "$f"; done' _ {} +

# Cloud Run sets PORT; the server reads it.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
