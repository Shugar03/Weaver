# Weaver web (Next.js) — deploy en Railway/Render/Fly/VPS.
# Contexto de build = RAÍZ del monorepo (igual que apps/gateway/Dockerfile).
# WEAVER_GATEWAY se lee en runtime por los Server Components → va como env
# del servicio, no hace falta en build.
FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @weaver/web...

FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY --from=deps /app ./
RUN pnpm --filter @weaver/web build

ENV NODE_ENV=production
WORKDIR /app/apps/web
EXPOSE 3000
# Railway inyecta PORT; next start lo toma de env.
CMD ["sh", "-c", "pnpm exec next start -p ${PORT:-3000} -H 0.0.0.0"]
