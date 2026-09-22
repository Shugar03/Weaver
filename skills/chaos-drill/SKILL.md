---
name: chaos-drill
description: Drill de failover de la red Weaver — mata el forge primario, verifica que el standby sirve y revive. Para demos y pruebas de resiliencia.
---

# Chaos Drill

Ejercicio completo de resiliencia de la red Weaver. Solo en modo EXEC.

## Pasos

1. `list_forges` — registrá el estado inicial (quién está HOT, ETRs).
2. Avisá al usuario qué vas a hacer: matar el forge primario para que el
   scheduler ruteé al standby.
3. `kill_forge` — el primario queda muerto.
4. `list_forges` — verificá: primario COLD/caído, standby recibiendo tráfico.
5. Opcional: `route_check` con el modelo — el scheduler debe elegir el standby.
6. `revive_forge` — el primario vuelve; el re-warm automático recarga el modelo.
7. `list_forges` — verificá recuperación (primario HOT de nuevo tras ~5s).

## Reporte

Contá qué pasó en orden: estado inicial → kill → quién sirvió → revive →
estado final. Con ETRs reales de cada paso. Si el failover no ocurrió,
decilo — jamás declares resiliencia que no verificaste.
