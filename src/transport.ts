import type { IngestBatch } from "./core/schema";
import { INGEST_LIMITS } from "./core/limits";
import { drainRequests } from "./capture";
import { diagnostics } from "./diagnostics";
import { drainUsage } from "./tracker";

const MAX_EVENTS_PER_BATCH = INGEST_LIMITS.events;
const UNLOAD_MAX_BYTES = 60_000;
const MAX_BATCH_BYTES = 1_000_000;
const MAX_PENDING_BYTES = 4_000_000;
const MAX_PENDING_EVENTS = 1000;
const MAX_PAUSE_MS = 60 * 60 * 1000;
let pausedUntil = 0;
let sending = false;
type Event = IngestBatch["events"][number];
const pending: { event: Event; bytes: number; attempts: number }[] = [];

/** Supports both delta seconds and HTTP-date Retry-After. */
export function pauseFrom(response: Pick<Response, "status" | "headers">) {
  if (response.status !== 429) return null;
  const value = response.headers.get("retry-after");
  const seconds = value?.trim() ? Number(value) : Number.NaN;
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : value
      ? Date.parse(value) - Date.now()
      : Number.NaN;
  return (
    Date.now() +
    Math.min(
      Math.max(Number.isFinite(delay) ? delay : 60_000, 1000),
      MAX_PAUSE_MS,
    )
  );
}

/** Browser-side isolation: one malformed event must never poison unrelated requests. */
function validEvent(event: Event): boolean {
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.length <= max;
  const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
  const paths = (values: string[]) =>
    values.length <= INGEST_LIMITS.leaves &&
    values.every((v) => text(v, INGEST_LIMITS.pathLength));
  if (event.type === "request") {
    return (
      text(event.id, 64) &&
      !!event.id &&
      text(event.method, 16) &&
      text(event.url, 4096) &&
      text(event.route, 2048) &&
      Number.isInteger(event.status) &&
      Number.isFinite(event.startedAt) &&
      nonnegative(event.durationMs) &&
      Number.isInteger(event.bytes) &&
      nonnegative(event.bytes) &&
      paths(event.leaves) &&
      (event.itemCount === null ||
        (Number.isInteger(event.itemCount) && nonnegative(event.itemCount)))
    );
  }
  return (
    text(event.requestId, 64) &&
    !!event.requestId &&
    paths(event.reads) &&
    (!event.queryKey || text(event.queryKey, 1024)) &&
    event.ops.length <= INGEST_LIMITS.ops &&
    event.ops.every(
      (op) =>
        text(op.op, 32) &&
        Number.isInteger(op.inCount) &&
        nonnegative(op.inCount) &&
        (op.outCount === null ||
          (Number.isInteger(op.outCount) && nonnegative(op.outCount))) &&
        nonnegative(op.ms) &&
        Number.isInteger(op.depth) &&
        nonnegative(op.depth),
    ) &&
    (!event.indexes ||
      (event.indexes.length <= INGEST_LIMITS.indexes &&
        event.indexes.every(
          (index) =>
            text(index.path, 512) &&
            Number.isInteger(index.max) &&
            nonnegative(index.max) &&
            Number.isInteger(index.length) &&
            nonnegative(index.length),
        )))
  );
}

/** Best effort delivery. Only explicitly rejected (429) or unsent events are retried;
 * ambiguous network/5xx failures are not replayed because usage ops aren't idempotent. */
export async function flush(
  endpoint: string,
  sessionId: string,
  key: string,
  onUnload = false,
  release?: string,
) {
  if (sending) return;
  const incoming = [...drainRequests(), ...drainUsage()];
  for (const event of incoming) {
    if (!validEvent(event)) {
      diagnostics.dropped++;
      continue;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (bytes >= MAX_BATCH_BYTES - 1024) {
      diagnostics.dropped++;
      continue;
    }
    pending.push({ event, bytes, attempts: 0 });
  }
  let queuedBytes = pending.reduce((sum, item) => sum + item.bytes, 0);
  while (
    pending.length > MAX_PENDING_EVENTS ||
    queuedBytes > MAX_PENDING_BYTES
  ) {
    queuedBytes -= pending.shift()?.bytes ?? 0;
    diagnostics.dropped++;
  }
  diagnostics.queued = pending.length;
  if (Date.now() < pausedUntil) return;
  pausedUntil = 0;
  diagnostics.pausedUntil = 0;
  sending = true;
  try {
    const blobOf = (items: typeof pending) =>
      new Blob(
        [
          JSON.stringify({
            key,
            sessionId,
            release: release?.slice(0, 128),
            events: items.map((item) => item.event),
          }),
        ],
        { type: "text/plain" },
      );
    while (pending.length) {
      let n = Math.min(MAX_EVENTS_PER_BATCH, pending.length);
      let body = blobOf(pending.slice(0, n));
      const limit = onUnload ? UNLOAD_MAX_BYTES : MAX_BATCH_BYTES;
      while (n > 1 && body.size >= limit) {
        n = Math.ceil(n / 2);
        body = blobOf(pending.slice(0, n));
      }
      const batch = pending.splice(0, n);
      if (body.size >= limit) {
        diagnostics.dropped += batch.length;
        continue;
      }
      diagnostics.retried += batch.filter((item) => item.attempts > 0).length;
      for (const item of batch) item.attempts++;
      try {
        if (onUnload && navigator.sendBeacon?.(endpoint, body)) {
          diagnostics.sent += batch.length;
          continue;
        }
        const response = await fetch(endpoint, {
          method: "POST",
          body,
          keepalive: body.size < UNLOAD_MAX_BYTES,
          signal: AbortSignal.timeout(10_000),
        });
        diagnostics.lastStatus = response.status;
        if (response.ok) {
          diagnostics.sent += batch.length;
          continue;
        }
        diagnostics.failures++;
        const pause = pauseFrom(response);
        if (pause !== null) {
          pausedUntil = pause;
          diagnostics.pausedUntil = pause;
          const retryable = batch.filter((item) => item.attempts < 3);
          diagnostics.dropped += batch.length - retryable.length;
          pending.unshift(...retryable);
          break;
        }
        diagnostics.dropped += batch.length;
        warnOnce();
        // Keep the remainder unsent; do not hammer a rejected/unavailable collector.
        pausedUntil = Date.now() + 60_000;
        diagnostics.pausedUntil = pausedUntil;
        break;
      } catch {
        diagnostics.failures++;
        diagnostics.lastStatus = null;
        diagnostics.dropped += batch.length;
        warnOnce();
        pausedUntil = Date.now() + 60_000;
        diagnostics.pausedUntil = pausedUntil;
        break;
      }
    }
  } finally {
    sending = false;
    diagnostics.queued = pending.length;
  }
}

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  console.warn(
    "[apiheron] telemetry delivery failed; inspect apiheron.getCaptureHealth() and the project's key/allowed origins.",
  );
}
