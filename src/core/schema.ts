import { z } from "zod";
import { INGEST_LIMITS } from "./limits";

// Ingest is a trust boundary: anything on localhost can POST to the collector.
// Every string and list is capped.

// These strings are shown in dashboards and sent on in webhooks, e-mails and
// MCP results, where a line break or a direction override lets a sender forge
// what follows. Cleaned rather than refused: one odd value must not cost a
// batch. Control characters, line and paragraph separators, bidi controls.
const UNSAFE = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu;
const line = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.replace(UNSAFE, " "));
/** Free text (a captured body): line breaks stay, NUL goes, which PostgreSQL rejects. */
const body = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.replaceAll("\u0000", ""));

const id = z
  .string()
  .min(1)
  .max(64)
  .transform((value) => value.replace(UNSAFE, " "));

export const OpSchema = z.object({
  op: line(32),
  inCount: z.number().int().nonnegative(),
  outCount: z.number().int().nonnegative().nullable(),
  ms: z.number().nonnegative(),
  depth: z.number().int().nonnegative(),
});

export const RequestEventSchema = z.object({
  type: z.literal("request"),
  id,
  source: z.enum(["fetch", "xhr", "axios"]),
  method: line(16),
  url: line(4096),
  /** Hash of the request body, so POSTs with different payloads are not duplicates. */
  bodyHash: line(16).nullish(),
  route: line(2048),
  status: z.number().int(),
  startedAt: z.number(),
  durationMs: z.number().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** Compressed body size from Resource Timing, else `content-length`; absent when neither is visible (no `Timing-Allow-Origin`, chunked). */
  wireBytes: z.number().int().positive().max(2_147_483_647).nullish(),
  /**
   * Resource Timing `responseStart - requestStart`: request sent to first
   * byte, the server's share without connection setup. Absent when the browser
   * hides it (cross-origin without `Timing-Allow-Origin`) and from SDKs before 0.6.
   */
  waitMs: z.number().nonnegative().max(86_400_000).nullish(),
  leaves: z.array(line(INGEST_LIMITS.pathLength)).max(INGEST_LIMITS.leaves),
  itemCount: z.number().int().nonnegative().nullable(),
  /** App call-site frames that started the request, e.g. `VersionPoll (version-poll.tsx:23)`. */
  initiator: line(1024).nullish(),
  /** Page pathname the request was made from, e.g. `/reservations`. */
  page: line(2048).nullish(),
  tracking: z.enum(["tracked", "untracked"]).nullish(),
  truncated: z.boolean().nullish(),
  sdkVersion: line(64).nullish(),
  scenario: line(INGEST_LIMITS.scenarioLength).nullish(),
  scenarioRunId: id.nullish(),
  /**
   * Only with `captureRequests`: the unmasked URL and body, secret-like names
   * masked, so the request can be copied as cURL. `omitted` says why a body
   * is missing.
   */
  replay: z
    .object({
      url: line(INGEST_LIMITS.replayUrlLength),
      body: body(INGEST_LIMITS.replayBodyLength).nullable(),
      omitted: z.enum(["unreadable", "too-large"]).nullish(),
      /**
       * Only with `captureResponses`: the JSON response as received, secret-like
       * fields masked, cut at `replayResponseLength` (`truncated`).
       */
      response: z
        .object({
          body: body(INGEST_LIMITS.replayResponseLength),
          truncated: z.boolean().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

/** Where "not read" is no evidence; absent from SDKs before 2026-09-17. */
const gaps = z
  .array(line(INGEST_LIMITS.pathLength))
  .max(INGEST_LIMITS.gaps)
  .optional();

export const UsageEventSchema = z.object({
  type: z.literal("usage"),
  requestId: id,
  reads: z.array(line(INGEST_LIMITS.pathLength)).max(INGEST_LIMITS.leaves),
  ops: z.array(OpSchema).max(INGEST_LIMITS.ops),
  queryKey: line(1024).optional(),
  /** Highest element index read per response array, for the pagination check. */
  indexes: z
    .array(
      z.object({
        path: line(INGEST_LIMITS.pathLength),
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
  release: line(128).optional(),
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
