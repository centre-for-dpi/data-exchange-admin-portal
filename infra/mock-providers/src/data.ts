/**
 * Deterministic synthetic data. No real person exists behind any record: identifiers are a
 * fixed sequence and attributes come from a seeded PRNG, so every run produces the same data.
 * Records hold no names or other personal attributes beyond what each mock service needs.
 */
export const FIRST_ID = 1_000_000_001;
export const PERSON_COUNT = 1_000;

/** mulberry32: tiny seeded PRNG, good enough for fixtures. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

function dateBetween(random: () => number, from: string, days: number): string {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Math.floor(random() * days));
  return date.toISOString().slice(0, 10);
}

export const identifiers = (): string[] =>
  Array.from({ length: PERSON_COUNT }, (_, i) => String(FIRST_ID + i));

export const REGIMENES = ['contributivo', 'subsidiado', 'especial'] as const;
export const ESTADOS_AFILIACION = ['activo', 'suspendido', 'retirado'] as const;
export const ASEGURADORAS = [
  'Aseguradora Ficticia Norte',
  'Aseguradora Ficticia Sur',
  'Aseguradora Ficticia Centro',
] as const;

export interface Afiliado {
  numeroIdentificacion: string;
  regimen: (typeof REGIMENES)[number];
  estado: (typeof ESTADOS_AFILIACION)[number];
  aseguradora: (typeof ASEGURADORAS)[number];
  fechaAfiliacion: string;
}

export function generateAfiliados(): Map<string, Afiliado> {
  const random = prng(0x5a1d);
  return new Map(
    identifiers().map((numeroIdentificacion) => {
      const roll = random();
      const estado = roll < 0.85 ? 'activo' : roll < 0.95 ? 'suspendido' : 'retirado';
      const record: Afiliado = {
        numeroIdentificacion,
        regimen: pick(random, REGIMENES),
        estado,
        aseguradora: pick(random, ASEGURADORAS),
        fechaAfiliacion: dateBetween(random, '2010-01-01', 5_000),
      };
      return [numeroIdentificacion, record];
    }),
  );
}

export const GRUPOS = ['A', 'B', 'C', 'D'] as const;

export interface Hogar {
  numeroIdentificacion: string;
  grupo: (typeof GRUPOS)[number];
  puntaje: number;
  integrantes: number;
  fechaEncuesta: string;
}

export function generateHogares(): Map<string, Hogar> {
  const random = prng(0x50c1);
  return new Map(
    identifiers().map((numeroIdentificacion) => {
      const puntaje = Math.round(random() * 10_000) / 100;
      const record: Hogar = {
        numeroIdentificacion,
        grupo: GRUPOS[Math.min(3, Math.floor(puntaje / 25))] ?? 'D',
        puntaje,
        integrantes: 1 + Math.floor(random() * 7),
        fechaEncuesta: dateBetween(random, '2021-01-01', 1_400),
      };
      return [numeroIdentificacion, record];
    }),
  );
}
