# syntax=docker/dockerfile:1
# API Rumbo — Node.js + Express (D-026).
# Targets:
#   dev        → usado por docker-compose de rumbo-devops (hot reload, código montado por volumen)
#   production → imagen portable de FALLBACK; el deploy principal es Vercel (ver DEPLOY.md en rumbo-devops)

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
# pnpm-workspace.yaml trae allowBuilds (esbuild) — sin él, pnpm 11 aborta el install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 4000
# Asume script "dev" con watch (tsx watch / nodemon); ajustar si cambia
CMD ["pnpm", "dev"]

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS production
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
EXPOSE 4000
USER node
CMD ["node", "dist/index.js"]
