import type { RequestEvent } from "./core/schema";
import { INGEST_LIMITS } from "./core/limits";
import { isIdSegment, normalizeRoute, shapeOf } from "./core/shape";
import { diagnostics, SDK_VERSION } from "./diagnostics";
import { nativeParse } from "./parse";
import { replayOf } from "./replay";
import { currentScenario, type Scenario } from "./scenario";
import { requestIdOf, track } from "./tracker";

// ponytail: drops oldest past MAX_QUEUED when the collector is down.
const MAX_QUEUED = 1000;
const queue: RequestEvent[] = [];
/** Last requests, kept after flush for the dev panel (`data-badge`). */
export const recent: RequestEvent[] = [];
const MAX_RECENT = 300;

type Captured = {
  source: RequestEvent["source"];
  method: string;
  url: string;
  body: unknown;
  status: number;
  /** `performance.now()` when the request started. */
  start: number;
  bytes: number;
  /** The response's `content-length` header, when the browser shows it. */
  contentLength?: number;
  data: unknown;
  /** `performance.now()` when the body finished downloading; defaults to now. */
  end?: number;
  /** From `callSite()`, taken when the request started. */
  initiator?: string | null;
  /** The app parsed the body itself: record the request, claim no field reads. */
  untracked?: boolean;
  scenario?: Scenario | null;
};

/** Dev-server internals (Next.js overlay, HMR) are not the app's API traffic. */
const IGNORED_PATHS = /\/(__nextjs[_/]|_next\/)/;
/** Substrings from `init({ ignore })` / `data-ignore`: matching URLs are not recorded. */
let ignored: string[] = [];
export const setIgnored = (patterns: string[]) => {
  ignored = patterns;
};

/**
 * Id-like path segments (numbers, uuids, tokens, email addresses) never leave
 * the page either: `/users/42` is sent as `/users/~1a2b3c`. Equal ids hash
 * alike, so duplicates and variants still line up.
 */
export function maskPath(url: string): string {
  const end = url.search(/[?#]/);
  const path = end === -1 ? url : url.slice(0, end);
  const from = path.includes("://") ? 3 : 0; // scheme, empty, host
  const masked = path
    .split("/")
    .map((s, i) => (i >= from && isIdSegment(s) ? `~${hash(s)}` : s))
    .join("/");
  return end === -1 ? masked : masked + url.slice(end);
}

/**
 * Query values never leave the page: each is replaced by its hash. Equal values
 * hash alike, so duplicate detection still works, while tokens, emails and ids
 * in the query never reach the collector. Keys stay readable.
 */
export function maskQuery(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const end = url.indexOf("#", q);
  const query = url.slice(q + 1, end === -1 ? undefined : end);
  const masked = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq === -1
        ? pair
        : `${pair.slice(0, eq)}=${hash(pair.slice(eq + 1))}`;
    })
    .join("&");
  return `${url.slice(0, q + 1)}${masked}${end === -1 ? "" : url.slice(end)}`;
}

const GRAPHQL_NAME = /^[A-Za-z_]\w*$/;

/**
 * GraphQL sends every operation to one URL, so the operation name joins the
 * route: `api.x/graphql#GetUser`. Only the name leaves the page, never the
 * query text or variables.
 */
export function graphqlOperation(body: unknown): string | null {
  try {
    const parsed =
      typeof body === "string" && /"(query|operationName)"/.test(body)
        ? nativeParse(body)
        : body;
    const { operationName, query } = Object(parsed);
    // Persisted queries send the name without the query text.
    const name =
      typeof operationName === "string" && GRAPHQL_NAME.test(operationName)
        ? operationName
        : /\b(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/.exec(
            typeof query === "string" ? query : "",
          )?.[1];
    return name ? name.slice(0, 64) : null;
  } catch {
    return null;
  }
}

/** Builds and queues the event; null when the URL is ignored. */
function record({
  source,
  method,
  url,
  body,
  status,
  start,
  bytes,
  contentLength,
  data,
  end = performance.now(),
  initiator = null,
  untracked = false,
  scenario = currentScenario(),
}: Captured) {
  if (IGNORED_PATHS.test(url) || ignored.some((p) => url.includes(p)))
    return null;
  const id = newId();
  const operation = graphqlOperation(body);
  const shape = shapeOf(data);
  const { itemCount } = shape;
  const truncated =
    !!shape.truncated ||
    shape.leaves.length > INGEST_LIMITS.leaves ||
    shape.leaves.some((p) => p.length > INGEST_LIMITS.pathLength);
  const leaves = shape.leaves
    .filter((p) => p.length <= INGEST_LIMITS.pathLength)
    .slice(0, INGEST_LIMITS.leaves);
  const event: RequestEvent = {
    type: "request",
    sdkVersion: SDK_VERSION,
    tracking: untracked ? "untracked" : "tracked",
    truncated,
    ...scenario,
    id,
    source,
    method: method.toUpperCase().slice(0, 16),
    url: maskQuery(maskPath(url)).slice(0, 4096),
    bodyHash: bodyHashOf(body),
    route:
      `${normalizeRoute(url, globalThis.location?.href)}${operation ? `#${operation}` : ""}`.slice(
        0,
        2048,
      ),
    status,
    // Wall clock, not timeOrigin: performance.now() drifts from Date.now() in long-lived tabs.
    startedAt: Date.now() - (performance.now() - start),
    durationMs: Math.max(0, end - start),
    bytes,
    leaves: untracked ? [] : leaves,
    itemCount,
    initiator: initiator?.slice(0, 1024) ?? null,
    page: globalThis.location?.pathname.slice(0, 2048) ?? null,
  };
  const replay = replayOf(url, body);
  if (replay) event.replay = replay;
  timingKeys.set(event, [url, start, contentLength]);
  queue.push(event);
  diagnostics.captured++;
  if (untracked) diagnostics.untracked++;
  if (truncated) diagnostics.truncated++;
  if (queue.length > MAX_QUEUED) {
    queue.shift();
    diagnostics.dropped++;
  }
  diagnostics.bufferedRequests = queue.length;
  recent.push(event);
  if (recent.length > MAX_RECENT) recent.shift();
  return { event, leaves };
}

/** Records a parsed JSON response and returns the tracking proxy to hand to the app. */
export function capture(input: Captured) {
  const recorded = record(input);
  if (!recorded || input.untracked) return input.data;
  const tracked = track(input.data, recorded.event.id);
  if (!requestIdOf(tracked)) {
    recorded.event.tracking = "untracked";
    diagnostics.untracked++;
  }
  return tracked;
}

/**
 * For bodies the app parses itself (XHR, `response.text()`): the request is
 * recorded as untracked, and only becomes tracked when the returned function
 * hands the proxy to the app. A response nobody parsed must not read as
 * "no field was used".
 */
export function captureLazy(input: Captured): () => unknown {
  const recorded = record({ ...input, untracked: true });
  let result: unknown;
  let adopted = false;
  return () => {
    if (adopted) return result;
    adopted = true;
    result = input.data;
    // Already sent as untracked: claiming reads now would contradict it.
    if (!recorded || !queue.includes(recorded.event)) return result;
    const tracked = track(input.data, recorded.event.id);
    if (requestIdOf(tracked)) {
      recorded.event.tracking = "tracked";
      recorded.event.leaves = recorded.leaves;
      diagnostics.untracked--;
      result = tracked;
    }
    return result;
  };
}

export function drainRequests(): RequestEvent[] {
  diagnostics.bufferedRequests = 0;
  const events = queue.splice(0);
  for (const event of events) {
    const wireBytes = wireBytesOf(event);
    if (wireBytes) event.wireBytes = wireBytes;
  }
  return events;
}

/** Unmasked URL, `performance.now()` start and `content-length`, kept until the event is sent. */
const timingKeys = new WeakMap<
  RequestEvent,
  [url: string, start: number, contentLength?: number]
>();

/**
 * Compressed body size from Resource Timing, read at send time because the
 * entry can land after the body resolves. Cross-origin responses report 0
 * without a `Timing-Allow-Origin` header; `content-length` then stands in: CORS
 * always exposes it, and it counts the body as sent. Chunked responses carry
 * neither, and nothing is sent.
 */
function wireBytesOf(event: RequestEvent): number | undefined {
  const [url, start, contentLength] = timingKeys.get(event) ?? [];
  const size = timingBytes(url, start) || contentLength || 0;
  return size > 0 ? Math.min(Math.round(size), 2_147_483_647) : undefined;
}

function timingBytes(url?: string, start?: number): number {
  try {
    if (!url || start === undefined) return 0;
    let best: PerformanceResourceTiming | undefined;
    for (const entry of performance.getEntriesByName(
      new URL(url, globalThis.location?.href).href,
      "resource",
    ) as PerformanceResourceTiming[]) {
      if (
        !best ||
        Math.abs(entry.startTime - start) < Math.abs(best.startTime - start)
      )
        best = entry;
    }
    return best?.encodedBodySize ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Tells payloads apart without sending them. Bodies that can't be read back
 * (FormData, Blob, streams) get a unique value: two uploads must never look
 * like the same request.
 */
export function bodyHashOf(body: unknown): string | null {
  if (body === undefined || body === null || body === "") return null;
  if (typeof body === "string") return hash(body);
  if (body instanceof URLSearchParams) return hash(body.toString());
  return newId().replace(/-/g, "").slice(0, 16);
}

/**
 * Frames from libraries, the framework and this SDK; the app's own frames
 * remain. Turbopack names vendor chunks after the package (`0567_axios_lib_…`)
 * without `node_modules`, so known client libraries are matched by name.
 */
const LIBRARY_FRAME =
  /node_modules|react[-_]dom|react[-_]server|next[\\/_]dist|scheduler|tanstack|axios[\\/_]lib|next-auth|next_auth|[@_]mantine|_esm_|_cjs_|_umd_|\/sdk\.js|[\\/](apiheron-)?sdk[\\/]src[\\/]|\(<anonymous>\)|\(native\)/;

export const isLibraryFrame = (frame: string) => LIBRARY_FRAME.test(frame);

/**
 * The first app frames of the current stack, e.g.
 * `VersionPoll.useEffect (version-poll_tsx_1a2b.js:23:17)`. Lets a developer
 * find the caller, and tells StrictMode's double effect (same call site) apart
 * from two components fetching the same data. Development builds keep names.
 */
export function callSite(): string | null {
  const errorClass = Error as { stackTraceLimit?: number };
  const limit = errorClass.stackTraceLimit;
  errorClass.stackTraceLimit = 40;
  const stack = new Error().stack ?? "";
  errorClass.stackTraceLimit = limit;
  const frames = stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim().replace(/^at /, ""))
    .filter((line) => line && !isLibraryFrame(line))
    .slice(0, 3)
    // Keep the file name, drop origin, folders and query strings.
    .map((frame) =>
      frame.replace(/(\(|@|^)[^()@\s]*\/([^/?#()\s]+)(\?[^:()\s]*)?/, "$1$2"),
    );
  return frames.length ? frames.join(" ← ").slice(0, 1024) : null;
}

/** FNV-1a. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export const byteLength = (text: string) =>
  new TextEncoder().encode(text).length;

/**
 * UTF-8 body size. content-length avoids a second copy of large bodies, but is
 * the compressed size under content-encoding, which cross-origin responses hide.
 */
export function bodyBytes(
  text: string,
  headers: { get(name: string): unknown },
  sameOrigin: boolean,
): number {
  const length = Number(headers.get("content-length"));
  return sameOrigin && !headers.get("content-encoding") && length > 0
    ? length
    : byteLength(text);
}

/** `content-length` as a number; undefined when absent or unreadable. */
export const contentLengthOf = (headers: { get(name: string): unknown }) =>
  Number(headers.get("content-length")) || undefined;

/** crypto.randomUUID only exists in secure contexts; http on a LAN IP is not one. */
export const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
