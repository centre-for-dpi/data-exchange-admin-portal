# ADR-0003 — TypeScript full-stack (Next.js + NestJS + PostgreSQL)

- Estado: Aceptado
- Fecha: 2026-11-11

## Contexto
Equipo pequeño, plazo corto, desarrollo asistido por Claude Code, y necesidad de que el operador encuentre talento local para mantenerlo.

## Decisión
Next.js (App Router) para la web, NestJS con Fastify para el API, PostgreSQL con Prisma, esquemas zod compartidos en `packages/contracts`, monorepo pnpm + Turborepo.

## Alternativas consideradas
- Python (FastAPI) + React: dos lenguajes, sin esquemas compartidos.
- Java (Spring Boot) + React: más pesado de arrancar para el plazo.
- Go + React: menos talento disponible en la región para la capa web.

## Consecuencias
- Un solo lenguaje y tipos compartidos entre web y API.
- Todas las piezas tienen licencia MIT/Apache-2.0.
