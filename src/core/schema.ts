import { z } from "zod";
import { INGEST_LIMITS } from "./limits";

// Ingest is a trust boundary: anything on localhost can POST to the collector.
// Every string and list is capped.

const id = z.string().min(1).max(64);

export const OpSchema = z.object({
  op: z.string().max(32),
  inCount: z.number().int().nonnegative(),
  outCount: z.number().int().nonnegative().nullable(),
  ms: z.number().nonnegative(),
  depth: z.number().int().nonnegative(),
});

export const RequestEventSchema = z.object({
  type: z.literal("request"),
  id,
  source: z.enum(["fetch", "xhr", "axios"]),
  method: z.string().max(16),
  url: z.string().max(4096),
  /** Hash of the request body, so POSTs with different payloads are not duplicates. */
  bodyHash: z.string().max(16).nullish(),
  route: z.string().max(2048),
  status: z.number().int(),
  startedAt: z.number(),
  durationMs: z.number().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** Compressed body size from Resource Timing, else `content-length`; absent when neither is visible (no `Timing-Allow-Origin`, chunked). */
  wireBytes: z.number().int().positive().max(2_147_483_647).nullish(),
  leaves: z
    .array(z.string().max(INGEST_LIMITS.pathLength))
    .max(INGEST_LIMITS.leaves),
  itemCount: z.number().int().nonnegative().nullable(),
  /** App call-site frames that started the request, e.g. `VersionPoll (version-poll.tsx:23)`. */
  initiator: z.string().max(1024).nullish(),
  /** Page pathname the request was made from, e.g. `/reservations`. */
  page: z.string().max(2048).nullish(),
  tracking: z.enum(["tracked", "untracked"]).nullish(),
  truncated: z.boolean().nullish(),
  sdkVersion: z.string().max(64).nullish(),
  scenario: z.string().max(INGEST_LIMITS.scenarioLength).nullish(),
  scenarioRunId: id.nullish(),
});

/** Where "not read" is no evidence; absent from SDKs before 2026-09-17. */
const gaps = z
  .array(z.string().max(INGEST_LIMITS.pathLength))
  .max(INGEST_LIMITS.gaps)
  .optional();

export const UsageEventSchema = z.object({
  type: z.literal("usage"),
  requestId: id,
  reads: z
    .array(z.string().max(INGEST_LIMITS.pathLength))
    .max(INGEST_LIMITS.leaves),
  ops: z.array(OpSchema).max(INGEST_LIMITS.ops),
  queryKey: z.string().max(1024).optional(),
  /** Highest element index read per response array, for the pagination check. */
  indexes: z
    .array(
      z.object({
        path: z.string().max(INGEST_LIMITS.pathLength),
        max: z.number().int().nonnegative(),
        length: z.number().int().nonnegative(),
      }),
    )
    .max(INGEST_LIMITS.indexes)
    .optional(),
  /** Object paths the app walked generically (Object.keys, spread, JSON.stringify). */
  enumerated: gaps,
  /** Paths the SDK handed out raw (frozen data): reads below them are invisible. */
  untracked: gaps,
});

export const IngestBatchSchema = z.object({
  sessionId: id,
  /** Build of the app that sent the batch, from `data-release`, e.g. a commit SHA. */
  release: z.string().max(128).optional(),
  /** Sender's `Date.now()` when the batch left, so the collector can undo clock skew; absent from SDKs before 2026-09-23. */
  sentAt: z.number().optional(),
  events: z
    .array(z.discriminatedUnion("type", [RequestEventSchema, UsageEventSchema]))
    .max(INGEST_LIMITS.events),
});

export type Op = z.infer<typeof OpSchema>;
export type RequestEvent = z.infer<typeof RequestEventSchema>;
export type UsageEvent = z.infer<typeof UsageEventSchema>;
export type IngestBatch = z.infer<typeof IngestBatchSchema>;
