# Weaver — CONTEXT.md (glosario, nada de implementación)

> Fuente de verdad del lenguaje. Si el código dice otra cosa, se cambia el código o se discute acá. Sin detalles de infra.

- **Job:** pedido de un usuario/agente por un modelo + input. No es un Request HTTP.
- **Forge:** rol económico que ejecuta cómputo (CPU/GPU/API). No es Host ni Node.
- **ModelInstance:** par Forge + modelo, con estado HOT/COLD, load_time, precio.
- **Execution:** un Job corrido en un Forge, con `result_hash` + proof.
- **Proof L0:** receipt firmado por el Forge (rápido, sin redundancia).
- **Proof L1:** ejecución redundante en 2 Forges sobre benchmark determinístico, se compara hash normalizado.
- **Settlement:** consecuencia económica en Stellar. No es el cobro x402 en sí.
- **ETR (Expected Time to Result):** `RTT + queue + load_si_COLD + prefill + gen + verify`. Única métrica de routing.
- **HOT:** ModelInstance con pesos ya en memoria, `load_time = 0`.
- **COLD:** ModelInstance que paga `load_time` antes de generar.
- **Take:** comisión Weaver (5–15% según §19 del paper).
