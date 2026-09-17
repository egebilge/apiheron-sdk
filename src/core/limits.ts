/** Shared wire limits. Browser-safe: deliberately independent of schema/Zod. */
export const INGEST_LIMITS = {
  leaves: 5000,
  pathLength: 512,
  ops: 500,
  indexes: 200,
  gaps: 200,
  events: 500,
  idLength: 64,
  urlLength: 4096,
  routeLength: 2048,
  queryKeyLength: 1024,
  scenarioLength: 128,
} as const;
