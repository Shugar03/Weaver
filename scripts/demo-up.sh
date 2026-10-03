#!/usr/bin/env bash
# Gateway demo Monad-only en :3501 — lee demo.env (gitignored, ver
# demo.env.example). El fleet: forges EVM remotos contra wss://…:3501.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f demo.env ]; then
  echo "falta demo.env — cp demo.env.example demo.env y completá los secrets" >&2
  exit 1
fi
set -a; . ./demo.env; set +a
exec node apps/gateway/src/serve.ts
