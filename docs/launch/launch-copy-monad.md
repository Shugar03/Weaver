# Guion y Copy de Re-render — Spot 30s (Monad + ERC-8004)

> Especificación escena por escena para el re-render determinista de `docs/launch/index.html` (`weaver-launch.mp4`).
> Mantiene duraciones exactas (30.0s, 16 compases a 128 BPM, `BAR = 1.875s`), estructura cinemática y sincronización de audio/gráficos.
> **Cambios respecto a v1:** sustitución de Stellar por Monad, incorporación de identidad y reputación de agentes bajo ERC-8004, actualización del recibo on-chain con hashes reales y CTA específico para **Metropolis Track 04**.

---

## 1. Mapeo de Objetos y Parámetros en DOM/Canvas

### Recibo On-Chain (Card Bezel) — Sincronizado a compás 11 (`19.3s – 22.6s`)

| Elemento | Texto Anterior (Stellar) | Texto Nuevo (Monad + ERC-8004) | Fuente / Valor Real |
|---|---|---|---|
| Header `.hd` | `SOROBAN ESCROW TESTNET` | `MONAD ESCROW · TESTNET` | Monad Testnet (Chain ID 10143) |
| Row 1 | `fund_job 0.01 USDC` | `fundJob 0.01 USDC` | Tx `0xd8393adb...` |
| Row 2 `#hash` | `result_hash sha256:········` → `sha256:a41f…c07e` | `resultHash sha256:9f9f…2695` | `result_hash_job_2` en `testnet.json` |
| Row 3 | `release → forge-07` | `release → 0x784E…F5CB` | Forge remoto real |
| Row 4 | `tx 00f8971a…d8eab` | `tx f06bff16…4b58` | `live_release_job_2` en `testnet.json` |
| Row 5 (Nuevo) | *(N/A)* | `erc8004 agent 1991 ✓` | Feedback `0xae89a2f0...` |
| Row 6 `#status`| `STATUS PENDING` → `SETTLED ✓` | `STATUS PENDING` → `SETTLED ✓` | Confirmación sub-segundo |

---

## 2. Bloques de Copy por Escena (ES + EN)

### Escena 1: El Hook (Bars 1–2 · `0:00 – 0:03.75`)
- **Visual:** Punto heroico pulsando en el vacío. Zoom rápido hacia adelante.
- **Copy ES:**
  - `b1` (0.95s): Headline XL: `"Los modelos abiertos *ganaron.*"`
  - `b2` (1.95s): Headline: `"Usarlos todavía *cuesta un peaje.*"`
    - Chips (2.92s tachados con rojo): `["+5.5% por recargar", "suscripciones con tope", "uptime “as-available”"]`
- **Copy EN:**
  - `b1`: Headline XL: `"Open models *won.*"`
  - `b2`: Headline: `"Running them still *costs a toll.*"`
    - Chips: `["+5.5% top-up fee", "capped subscriptions", "“as-available” uptime"]`

---

### Escena 2: El Silicio Ocioso (Bars 3–4 · `0:03.75 – 0:07.50`)
- **Visual:** The Drop. Pull-out violento de cámara revelando la constelación de 1.700 nodos en el plano 3D.
- **Copy ES:**
  - `b3` (4.25s): Eyebrow: `// el insight` · Headline: `"1.500 millones de PCs."` · Sub: `"Ociosas la mayor parte del día."`
  - `b4` (5.80s): Headline XL: `"El silicio ya está *ahí afuera.*"`
- **Copy EN:**
  - `b3`: Eyebrow: `// the insight` · Headline: `"1.5 billion PCs."` · Sub: `"Idle most of the day."`
  - `b4`: Headline XL: `"The silicon is *already out there.*"`

---

### Escena 3: The Weave / Logo Lockup (Bars 5–6 · `0:07.50 – 0:11.25`)
- **Visual:** Los nodos se interconectan con haces lima. Las partículas convergen para ensamblar el isotipo de Weaver.
- **Copy ES:**
  - `b5w` (9.42s): Wordmark: `"W E A V E R"`
  - `b5t` (9.82s): Headline: `"El nuevo datacenter *no tiene paredes.*"`
- **Copy EN:**
  - `b5w`: Wordmark: `"W E A V E R"`
  - `b5t`: Headline: `"The new datacenter *has no walls.*"`

---

### Escena 4: Ruteo por ETR Medido (Bars 7–8 · `0:11.25 – 0:15.00`)
- **Visual:** Inmersión en el clúster activo. Escaneo radial de radar midiendo latencias. Selección del nodo HOT.
- **Tags de Telemetría:**
  - Cliente: `"vos · POST /v1/chat/completions"`
  - Nodo frío: `"forge-03 · COLD · ETR 1.42s"`
  - Nodo primario: `"forge-11 · HOT · ETR 0.41s"`
  - Nodo standby: `"forge-07 · HOT · ETR 0.88s"`
- **Copy ES:**
  - `b6` (12.15s): Eyebrow: `// 01 · ruteo` · Headline: `"Cada request, *al forge más rápido.*"` · Sub: `"ETR medido en tiempo real — no prometido."`
- **Copy EN:**
  - `b6`: Eyebrow: `// 01 · route` · Headline: `"Every request, *to the fastest forge.*"` · Sub: `"Scored on measured ETR — not promises."`

---

### Escena 5: Tolerancia a Fallos en Vivo (Bars 9–10 · `0:15.00 – 0:18.75`)
- **Visual:** Glitch sonoro e impacto visual. El forge primario muere (`forge-11 · DEAD`). El thread conmuta a `forge-07` instantáneamente.
- **Copy ES:**
  - `b7` (15.30s): Eyebrow: `// 02 · failover` · Headline: `"Los nodos caen. *La red no.*"` · Sub: `"El standby toma el flujo en <15ms, sin error 500."`
- **Copy EN:**
  - `b7`: Eyebrow: `// 02 · failover` · Headline: `"Nodes fall. *The network doesn't.*"` · Sub: `"Standby picks up in <15ms without dropping tokens."`

---

### Escena 6: Liquidación en Monad y Reputación ERC-8004 (Bars 11–12 · `0:18.75 – 0:22.50`)
- **Visual:** Cámara panea hacia el hexágono del escrow. Haces transmiten el hash y la firma secp256k1. Despliegue del recibo animado `#card`. Partícula de USDC liberada al worker.
- **Copy ES:**
  - `b8` (19.55s): Eyebrow: `// 03 · liquidación + confianza` · Headline: `"Liquidado en Monad. *Reputación ERC-8004.*"` · Sub: `"Escrow sub-segundo con proof L0 · Identidad soberana de agente."`
- **Copy EN:**
  - `b8`: Eyebrow: `// 03 · settle + trust` · Headline: `"Settled on Monad. *ERC-8004 reputation.*"` · Sub: `"Sub-second escrow with L0 delivery proof · Sovereign agent identity."`

---

### Escena 7: Zero Data Retention (Bars 13–14 · `0:22.50 – 0:26.25`)
- **Visual:** Close-up a la terminal del cliente. El texto del prompt en pantalla se disuelve en partículas que se evaporan al cerrar el socket.
- **Overlay:**
  - Tag superior: `PROMPT · SOLO RAM · forge-07`
  - Prompt: `“Resumí mis análisis y marcá lo anormal.”` / `“Summarize my lab results and flag anything off.”`
  - Estado post-stream: `request cerrado · memoria liberada · 0 bytes en disco`
- **Copy ES:**
  - `b9` (23.55s): Eyebrow: `// 04 · zero data` · Headline: `"Tu prompt vive en RAM. *Y muere ahí.*"` · Sub: `"La cadena solo ve dinero y pruebas criptográficas."`
- **Copy EN:**
  - `b9`: Eyebrow: `// 04 · zero data` · Headline: `"Your prompt lives in RAM. *And dies there.*"` · Sub: `"The chain only ever sees money and cryptographic proofs."`

---

### Escena 8: Cierre y CTA Track 04 (Bars 15–16 · `0:26.25 – 0:30.00`)
- **Visual:** Pull-out monumental a vista global iluminada con resplandor lima. Isotipo y wordmark final. Fade out limpio a negro a los 29.4s.
- **Copy ES:**
  - `b10w` (27.95s): Wordmark: `"W E A V E R"`
  - `b10t` (28.30s): Headline: `"El nuevo datacenter *no tiene paredes.*"` · Sub: `"Inferencia abierta en cualquier GPU · Monad Metropolis Track 04"`
- **Copy EN:**
  - `b10w`: Wordmark: `"W E A V E R"`
  - `b10t`: Headline: `"The new datacenter *has no walls.*"` · Sub: `"Open inference on any GPU · Monad Metropolis Track 04"`

---

## 3. Instrucciones de Inyección en `index.html` (para render sin tocar código ahora)

Para aplicar este copy durante el re-render por script headless (`scripts/render-video.mjs` o Chrome capture):
1. El objeto `COPY.es` y `COPY.en` en `index.html` (líneas 108–144) se sobreescribe con las cadenas de arriba.
2. En `#card` (líneas 79–86), reemplazar `SOROBAN ESCROW TESTNET` por `MONAD ESCROW · TESTNET` y actualizar las claves del recibo según la tabla §1.
3. En `syncDom(t)` (línea 103), el hash objetivo pasa a ser `sha256:9f9f…2695`.
4. El pipeline gráfico de GSAP, física de partículas, síntesis Web Audio y timing se mantienen con 100% de paridad determinista.
