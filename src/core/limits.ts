/** Shared wire limits. Browser-safe: deliberately independent of schema/Zod. */
export const INGEST_LIMITS = {
  leaves: 5000,
  pathLength: 512,
  /**
   * Characters of paths one request keeps per list. Server-side only: the
   * collector cuts a longer list and marks the request truncated.
   */
  pathChars: 128_000,
  ops: 500,
  indexes: 200,
  gaps: 200,
  events: 500,
  idLength: 64,
  urlLength: 4096,
  routeLength: 2048,
  queryKeyLength: 1024,
  scenarioLength: 128,
  /** Opt-in request replay (`captureRequests`): URL and body, in characters. */
  replayUrlLength: 8192,
  replayBodyLength: 8192,
  /** Opt-in `captureResponses`: response body kept up to this many characters, cut beyond. */
  replayResponseLength: 32768,
} as const;
