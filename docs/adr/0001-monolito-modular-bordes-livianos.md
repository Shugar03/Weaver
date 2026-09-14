# ADR 0001 — Monolito modular con bordes hexagonales livianos

Fecha: 2026-09-14 · Estado: aceptado

## Contexto

Hackathon 13 días, 1 dev, 1 MacBook Air M5 16GB sin GPU dedicada. Hay que demostrar routing ETR + fallback + settlement Stellar sin morir de infra.

Alternativas reales: (A) hex liviano elegido, (B) hex full purista con capas estrictas + DI, (C) monolito directo sin seams.

## Decisión

Un deploy (monolito), Modules con una sola Interface chica cada uno, Adapters solo donde algo varía de verdad (ForgeExec: Ollama vs API). El resto con un Adapter + fake in-memory para tests. Sin DI container, sin capas application/domain/infra obligatorias.

## Porqué

- B habría costado +3-4 días por burocracia y no paga en demo.
- C deja el fix de routing desparramado en N callers cuando falle en vivo (sin Locality).
- A da Depth donde importa (Scheduler) y Seams reales solo con 2+ Adapters (regla codebase-design).

## Consecuencias

- Scheduler, Settlement, ForgeExec, Telemetry viven en `packages/*` con Interface de 1-2 métodos.
- Si mañana sumamos Parallax-like o Vast spot, es un Adapter nuevo, sin tocar Scheduler.
- Revertir a microservicios sigue posible porque los Seams ya existen.
