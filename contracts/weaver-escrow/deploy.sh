#!/usr/bin/env bash
# Deploy del escrow v4 a testnet (ADR-0006 runbook).
# Uso: ADMIN_SECRET=S... ADMIN_G=G... USDC_SAC=C... ./deploy.sh
# El v3 desplegado NO se puede upgradear (sin función upgrade) — esto crea
# un contrato nuevo; actualizar SETTLEMENT_CONTRACT en el gateway después.
set -euo pipefail
cd "$(dirname "$0")"

: "${ADMIN_SECRET:?secret del operador (fondea jobs, firma init)}"
: "${ADMIN_G:?pubkey del operador (G... — queda admin del contrato)}"
: "${USDC_SAC:?contract id del SAC de pago}"
NETWORK="${NETWORK:-testnet}"

stellar contract build
WASM=target/wasm32v1-none/release/weaver_escrow.wasm

CONTRACT_ID=$(stellar contract deploy --wasm "$WASM" --source "$ADMIN_SECRET" --network "$NETWORK")
echo "contract_id: $CONTRACT_ID"

stellar contract invoke --id "$CONTRACT_ID" --source "$ADMIN_SECRET" --network "$NETWORK" -- \
  init --admin "$ADMIN_G" --token "$USDC_SAC"

echo "v4 deployado e inicializado. Siguiente:"
echo "  1. gateway:  SETTLEMENT_CONTRACT=$CONTRACT_ID (+ SETTLEMENT_SECRET=$ADMIN_SECRET)"
echo "  2. forges:   weaver-forge register --contract $CONTRACT_ID"
echo "  3. registrar el deploy en deployments/testnet.json"
