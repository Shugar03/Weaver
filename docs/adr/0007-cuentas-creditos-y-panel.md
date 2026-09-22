# ADR 0007 — Cuentas, créditos y panel de usuario (consumidor OpenRouter-style)

Fecha: 2026-09-23 · Estado: aceptado

## Contexto

Weaver sirve inferencia OpenAI-compatible pero el "usuario final" no existía:
las keys las emitía solo el operador (`/v1/admin/keys`), el metering por key
existía (`/v1/usage`) sin plata atada, y x402 por-request no funciona dentro
de agentes como OpenCode/Pi/Hermes (mandan un `Bearer` fijo — no pueden
pagar por request). Para que una `wvr_` key sea usable de verdad en esos
clientes, la cuenta necesita **crédito prepago** debitado post-serve.

## Decisiones

- **Identidad dual**: cuenta anónima (`POST /v1/accounts` → management
  token `wvr_acct_…`, mostrado una vez) + wallet Stellar linkeable
  (`challenge → firma → wvr_sess_`). Una cuenta puede tener ambos;
  `memo = wallet pubkey` hace que el depósito USDC auto-ate.
- **Créditos en stroops**: ledger append-only `credit_events`
  (kind: topup|debit, amount_i128, ref dedup, created_at). Balance =
  suma; el debit jamás excede lo servido (post-stream, medido).
- **Pricing por modelo**: tabla `pricing {model, prompt_per_mtok,
  completion_per_mtok, image_flat}` en stroops. `GET /v1/pricing`
  público — el usuario ve el precio ANTES de gastar.
- **402 honesto**: balance < costo estimado mínimo → `402 payment
  required` antes de ejecutar. Debit real post-stream sobre
  `prompt_tokens`/`completion_tokens` del usage (medido, no declarado —
  el mismo que alimenta el settle del forge).
- **DepositWatcher** (corrección implementada): los memos solo existen
  en **payments clásicos** — un transfer SAC por invoke host function no
  lleva memo. El watcher pollea **Horizon**
  (`/accounts/{depositAddress}/payments?join=transactions`), valida
  destino/asset/issuer/memo y acredita deduplicado por **operation id**
  (ref `dep:<opId>` — crash-safe: reprocesar no duplica).
  Corre en el gateway solo con `DEPOSIT_ADDRESS` + `USDC_ISSUER` +
  `DATABASE_URL` configurados.
- **Keys self-serve**: `/v1/me/keys` CRUD sobre las keys del caller —
  `keyOwner = accountId`. Las keys existentes sin cuenta siguen
  funcionando sin billing (compat dev/embedded).
- **Marketplace** (S48): `GET /v1/catalog` público — join de metadata
  declarada por el operador (`MODEL_CATALOG` env JSON: name, description,
  context, features, docs) + fleet viva (providers, hot) + pricing +
  telemetría medida (p50 TTFT, tok/s). Lo no declarado sale con
  `declared:false` y campos `null`; lo no medido sale `null` — el front
  muestra "—" o "not declared", jamás números inventados. Web:
  `/models` (lista filtrable) y `/models/[id]` (detalle + snippet + CTA).
- **Panel web** (`/account`): login por mgmt token o firma wallet manual
  (v1 sin Freighter), tabs Overview (balance + checklist + depósito),
  Keys (CRUD, secreto una vez), Billing (ledger con links al explorer),
  Integrate (snippets OpenAI-compat con key del usuario).

## Invariantes

- **A1**: el secreto (`wvr_`, `wvr_acct_`, `wvr_sess_`) jamás se guarda
  en claro — solo SHA-256. Jamás se loguea.
- **A2**: un débito jamás inventa plata — `debit` exige costo calculado
  del usage real servido; `topup` exige tx on-chain deduplicada.
- **A3**: sin balance suficiente no se sirve (402), pero un serve ya
  iniciado se completa y debita (el underflow queda visible en ledger —
  nunca se trunca el stream del cliente por plata mid-flight).
- **A4**: toda la superficie `/v1/me/*` requiere auth — cuenta aislada
  por token; un usuario jamás ve ni revoca keys ajenas.
- **A5**: compat — gateway sin `DATABASE_URL` o sin accounts configurado
  se comporta exactamente como hoy (opt-in como el resto del sistema).

## Env vars (implementación)

| var | gateway | efecto |
|---|---|---|
| `DATABASE_URL` | sí | cuentas/ledger persisten; sin ella in-memory |
| `MODEL_PRICING` | sí | `{"model":{"prompt":N,"completion":N,"image":N}}` stroops/Mtok |
| `MODEL_CATALOG` | sí | metadata declarada del marketplace (name/context/features/docs) |
| `DEPOSIT_ADDRESS` | sí | address USDC que recibe topups (activa watcher) |
| `USDC_ISSUER` | sí | issuer del SAC USDC para validar pagos |
| `HORIZON_URL` | sí | Horizon a pollear (default testnet) |
| `DEPOSIT_POLL_MS` | sí | intervalo del watcher (default 15s) |
| `NEXT_PUBLIC_GATEWAY` | web | URL del gateway para el browser |

## Fuera de scope (declarado)

- Suscripciones/rate-tiers, auto-topup, refunds de crédito, facturación
  fiat, multi-asset (solo USDC SAC), quotas por key, y panel admin de
  cuentas. Freighter/wallet-kit en el browser (v1 pide firma manual —
  el usuario firma con su herramienta; la UX de wallet-connect es
  mejora posterior).
