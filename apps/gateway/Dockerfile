# Weaver gateway — deploy en Railway/Render/Fly/VPS.
# Contexto de build = RAÍZ del monorepo (los packages @weaver/* exportan .ts
# y Node 24 los corre con type-stripping nativo — no hay build step).
FROM node:24-alpine
RUN corepack enable
WORKDIR /app

# Manifests + lockfile primero: el layer de deps se cachea aparte del código.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/gateway ./apps/gateway

# --filter @weaver/gateway... instala el gateway + sus deps de workspace.
RUN pnpm install --frozen-lockfile --filter @weaver/gateway...

ENV HOST=0.0.0.0 \
    NODE_ENV=production
# Railway inyecta PORT; el gateway lo lee de process.env.PORT.
EXPOSE 3001

# REMOTE_ONLY=1 en el host remoto: sin Ollama/mflux acá, la fleet entra por
# el WS de forges remotos (/v1/forge/ws). Sin el flag, registra fantasmas.
CMD ["node", "apps/gateway/src/serve.ts"]
