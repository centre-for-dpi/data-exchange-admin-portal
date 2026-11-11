# ADR-0007 — Outbox + reconciliadores idempotentes sobre pg-boss

- Estado: Aceptado
- Fecha: 2026-11-11

## Contexto
El estado de dominio vive en PostgreSQL y debe reflejarse en APISIX, Keycloak y OPA. Escribir en esos sistemas desde los controladores produce estados a medias cuando algo falla.

## Decisión
Cada cambio de dominio inserta un registro en `outbox` en la misma transacción. Un worker con **pg-boss** (cola sobre PostgreSQL) dispara reconciliadores que calculan el estado deseado y aplican diferencias con IDs deterministas. Además hay una reconciliación completa cada 5 minutos.

## Alternativas consideradas
- Redis + BullMQ: un componente más que operar.
- Kafka: desproporcionado para el volumen de cambios de gobierno.

## Consecuencias
- Recuperación automática de fallas parciales y detección de deriva.
- Un solo almacén que respaldar.
