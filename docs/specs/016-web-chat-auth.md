# spec 016 — web chat auth: la key de la cuenta cierra el loop prepaid

## Problema

La web crea API keys `wvr_` reales (KeysTab) pero el chat las ignora — todos
los requests salen anónimos. Consecuencias:

- Con paywall ON (prod/demo :3501), la UI propia pega 402 — el producto se
  rompe a sí mismo.
- Sin paywall, el uso no se atribuye a la cuenta → `usage(keyId)` siempre
  vacío → BillingTab no puede mostrar el gasto real del usuario.
- El loop "cuenta → créditos → inferencia debitada" existe server-side
  (keyId + CreditLedger.debit por job) pero ningún cliente lo ejercita.

## Diseño

- `weaver:api-key` en localStorage, distinto de `weaver:operator-key`
  (admin kill — otro privilegio, no se mezcla).
- `apiKey()`/`saveApiKey()`/`clearApiKey()` en `weaver.ts`.
- `postJobs`, `streamChat` y `uploadDoc` adjuntan `Authorization: Bearer`
  cuando hay key — mismo canal que cualquier cliente OpenAI-compatible.
- `KeysTab`: al crear una key se guarda automáticamente para el chat y se
  avisa ("esta key ya alimenta el chat"). Manual pegar/borrar también se
  soporta.
- Logout de cuenta → `clearApiKey()` (la key es secreto del account).
- 401 en chat → `clearApiKey()` + error "key inválida — crealá en /account":
  una key revocada no debe quedar pegada repitiendo el fallo.

## Efecto

Con key → `keyId` seteado → paywall bypass (S15a) + débito prepaid por job
en el CreditLedger + usage por key en BillingTab. Sin key → comportamiento
actual (paywall si ON, abierto si dev).

## Honestidad

- Nunca se sintetiza una key — el campo vacío sigue siendo request anónimo.
- El 401 es visible, jamás retry silencioso con otra cosa.

## Tests

- `weaver.ts`: `apiKey` round-trip/clear (jsdom-free: guard try/catch ya
  existente — test via stub de localStorage si aplica al harness actual).
- Gateway ya cubre el camino keyed (apiKeys tests existentes); aquí solo el
  cable cliente.
