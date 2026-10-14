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

# Cloud Run sets PORT; the server reads it.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
