import type { Op, UsageEvent } from "./core/schema";
import { INGEST_LIMITS } from "./core/limits";
import { joinPath } from "./core/shape";
import { callSite } from "./capture";
import { diagnostics } from "./diagnostics";

type Usage = {
  seen: Set<string>;
  reads: string[];
  ops: Op[];
  queryKey?: string;
  /** Per op key: false when only library frames call it (a UI kit's internals). */
  appOps: Map<string, boolean>;
  /** Per array path: highest element index read and the array length. */
  indexes: Map<string, [max: number, length: number]>;
  indexesChanged: boolean;
  /** Object paths walked generically: Object.keys, for…in, spread, JSON.stringify. */
  enumerated: Set<string>;
  /** Paths handed out raw (frozen data): reads below them are invisible. */
  untracked: Set<string>;
  gapsChanged: boolean;
};

// ponytail: in-memory, oldest evicted past MAX_REQUESTS. Late reads on an
// evicted request are dropped; raise the cap if long sessions lose data.
const MAX_REQUESTS = 500;
const usage = new Map<string, Usage>();
const proxies = new WeakMap<object, object>();
const targets = new WeakMap<object, object>();
const owners = new WeakMap<object, string>();
// Child paths shared by every proxy at the same path, so reading `row.name`
// across 10k rows does not build 10k strings.
const childPaths = new Map<string, Map<string, string>>();

/** Property reads that are runtime/library probes, not the app consuming data. */
const IGNORED = new Set([
  "toJSON",
  "then",
  "constructor",
  "$$typeof",
  "__proto__",
]);
const ARRAY_OPS = new Set([
  "filter",
  "map",
  "flatMap",
  "reduce",
  "sort",
  "toSorted",
]);

// A generic walk (spread, Object.entries, JSON.stringify) asks for a key's
// descriptor right before it gets the value. That `get` is the walk's, not the
// app's: it must not count as a read of the field.
let walked: object | undefined;
let walkedKey: string | symbol | undefined;
// JSON.stringify differs: it probes `toJSON`, asks for every descriptor, then
// gets every value, with nested objects in between. The gets it still owes are
// counted per target; `open` keeps the lookup off the hot path.
// ponytail: a stringify that throws midway leaves `open` raised (one WeakMap
// lookup per get from then on) and hides that many later reads of the target.
let probed: object | undefined;
const owed = new WeakMap<object, number>();
let open = 0;

/** True when this `get` belongs to a generic walk rather than to the app. */
function isWalk(target: object, key: string): boolean {
  const left = open ? owed.get(target) : 0;
  if (left) {
    owed.set(target, left - 1);
    if (left === 1) open--;
    if (walked === target) walked = undefined;
    return true;
  }
  if (walked !== target || walkedKey !== key) return false;
  walked = undefined;
  return true;
}

let paused = 0;

/** Runs `fn` without recording reads, e.g. a library's deep compare. */
export function untracked<T>(fn: () => T): T {
  paused++;
  try {
    return fn();
  } finally {
    paused--;
  }
}

/** Returns `data` wrapped so every property read and array transform is recorded for `requestId`. */
export function track<T>(data: T, requestId: string): T {
  if (!usage.has(requestId))
    usage.set(requestId, {
      seen: new Set(),
      reads: [],
      ops: [],
      appOps: new Map(),
      indexes: new Map(),
      indexesChanged: false,
      enumerated: new Set(),
      untracked: new Set(),
      gapsChanged: false,
    });
  if (usage.size > MAX_REQUESTS) {
    const oldest = usage.keys().next().value;
    if (oldest) usage.delete(oldest);
  }
  return wrap(data, requestId, "", 0);
}

/** Raw object behind a tracking proxy, for structuredClone/postMessage (proxies cannot be cloned). */
export function unwrap<T>(value: T): T {
  return typeof value === "object" && value !== null
    ? ((targets.get(value) as T | undefined) ?? value)
    : value;
}

export function requestIdOf(value: unknown): string | undefined {
  return typeof value === "object" && value !== null
    ? owners.get(value)
    : undefined;
}

/** Distinct field paths the app has read from a response so far. */
export function readsOf(requestId: string): string[] {
  return [...(usage.get(requestId)?.seen ?? [])];
}

export function setQueryKey(requestId: string, queryKey: string) {
  const entry = usage.get(requestId);
  if (entry) entry.queryKey = queryKey;
}

/** Reads, ops, and query keys recorded since the last drain. */
export function drainUsage(): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const [requestId, entry] of usage) {
    if (
      !entry.reads.length &&
      !entry.ops.length &&
      !entry.queryKey &&
      !entry.indexesChanged &&
      !entry.gapsChanged
    )
      continue;
    events.push({
      type: "usage",
      requestId,
      reads: entry.reads,
      ops: entry.ops,
      ...(entry.queryKey && { queryKey: entry.queryKey }),
      ...(entry.indexesChanged && {
        indexes: [...entry.indexes]
          .slice(0, INGEST_LIMITS.indexes)
          .map(([path, [max, length]]) => ({ path, max, length })),
      }),
      ...(entry.gapsChanged && {
        enumerated: [...entry.enumerated],
        untracked: [...entry.untracked],
      }),
    });
    entry.reads = [];
    entry.ops = [];
    entry.queryKey = undefined;
    entry.indexesChanged = false;
    entry.gapsChanged = false;
  }
  return events;
}

/** One record per path, however many rows share it. False when it could not be kept. */
function noteGap(
  requestId: string,
  kind: "enumerated" | "untracked",
  path: string,
): boolean {
  const entry = usage.get(requestId);
  if (!entry) return false;
  const paths = entry[kind];
  if (paths.has(path)) return true;
  if (
    paths.size >= INGEST_LIMITS.gaps ||
    path.length > INGEST_LIMITS.pathLength
  )
    return false;
  paths.add(path);
  entry.gapsChanged = true;
  return true;
}

function noteIndex(
  requestId: string,
  path: string,
  index: number,
  length: number,
) {
  const entry = usage.get(requestId);
  if (!entry) return;
  const previous = entry.indexes.get(path);
  if (previous && previous[0] >= index && previous[1] === length) return;
  entry.indexes.set(path, [Math.max(previous?.[0] ?? -1, index), length]);
  entry.indexesChanged = true;
}

function record(requestId: string, path: string) {
  if (path.length > INGEST_LIMITS.pathLength) {
    diagnostics.truncatedUsage++;
    return;
  }
  const entry = usage.get(requestId);
  if (!entry || entry.seen.has(path)) return;
  if (entry.seen.size >= INGEST_LIMITS.leaves) {
    diagnostics.truncatedUsage++;
    return;
  }
  entry.seen.add(path);
  entry.reads.push(path);
}

/**
 * Only shapes JSON.parse can produce. Map, Set, Date, and class instances use
 * internal slots, so their methods throw when called on a Proxy
 * ("Map.prototype.get called on incompatible receiver"). Apps do attach such
 * values to response objects.
 */
function isJsonShaped(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function childPath(path: string, key: string): string {
  let byKey = childPaths.get(path);
  if (!byKey) {
    if (childPaths.size >= 5000) childPaths.clear();
    byKey = new Map();
    childPaths.set(path, byKey);
  }
  let child = byKey.get(key);
  if (child === undefined) {
    child = joinPath(path, key);
    byKey.set(key, child);
  }
  return child;
}

/**
 * Proxy invariant: a non-configurable, non-writable property must be returned
 * as-is. Only reachable once the target was frozen/sealed after wrapping (immer).
 */
function mustReturnRaw(target: object, key: string): boolean {
  if (Reflect.isExtensible(target)) return false;
  const desc = Reflect.getOwnPropertyDescriptor(target, key);
  return !!desc && !desc.configurable && !desc.writable;
}

/** A raw object leaves tracking: say so, or its fields would read as unused. */
function raw<T>(value: T, requestId: string, path: string): T {
  if (typeof value === "object" && value !== null)
    noteGap(requestId, "untracked", path);
  return value;
}

function wrap<T>(value: T, requestId: string, path: string, depth: number): T {
  if (value === null || typeof value !== "object" || !isJsonShaped(value)) {
    return value;
  }
  if (Object.isFrozen(value)) return raw(value, requestId, path);
  if (owners.has(value)) {
    owners.set(value, requestId);
    return value;
  }
  const cached = proxies.get(value);
  if (cached) {
    owners.set(cached, requestId);
    return cached as T;
  }

  const itemPath = `${path}[]`;
  const proxy = new Proxy(value, {
    get(target, key, receiver) {
      const requestId = owners.get(receiver) ?? owners.get(proxy) ?? "";
      const result = Reflect.get(target, key, receiver);
      if (paused || typeof key === "symbol" || IGNORED.has(key)) {
        if (key === "toJSON") probed = target;
        return result;
      }

      if (Array.isArray(target)) {
        if (typeof result === "function") {
          return ARRAY_OPS.has(key)
            ? instrumentOp(
                target,
                key,
                result as (...args: unknown[]) => unknown,
                receiver,
                requestId,
                path,
                depth,
              )
            : result;
        }
        // A derived array (filter/map output) holds either response elements,
        // which are already proxies that track themselves, or objects the app
        // built. The app's objects must not count as reads of the response.
        // `length` is list size, not element data.
        if (depth > 0 || key === "length") return result;
        // ponytail: JSON.stringify of a primitive array (`tags[]`) still counts
        // as a read; its gets look like the app's. Objects inside do not.
        record(requestId, itemPath);
        // A list read only up to an early index (slice, virtualized, "show
        // more") hints at missing pagination.
        const index = Number(key);
        if (Number.isInteger(index) && index >= 0)
          noteIndex(requestId, itemPath, index, target.length);
        return mustReturnRaw(target, key)
          ? raw(result, requestId, itemPath)
          : wrap(result, requestId, itemPath, 0);
      }

      // Probing a missing key (`row.foo ?? x`) is not reading response data.
      if (typeof result === "function" || !Object.hasOwn(target, key)) {
        return result;
      }
      const child = childPath(path, key);
      if (!isWalk(target, key)) record(requestId, child);
      return mustReturnRaw(target, key)
        ? raw(result, requestId, child)
        : wrap(result, requestId, child, 0);
    },
    // Walking an object's keys is generic handling, not proof each field is
    // used. Array keys are indexes, not fields.
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      if (
        !paused &&
        !Array.isArray(target) &&
        noteGap(owners.get(proxy) ?? "", "enumerated", path) &&
        probed === target &&
        keys.length
      ) {
        if (!owed.get(target)) open++;
        owed.set(target, keys.length);
      }
      probed = undefined;
      return keys;
    },
    // Only once the walk is on record: a dropped read must never leave the
    // field looking unread (`Object.hasOwn(row, k) && row[k]`).
    getOwnPropertyDescriptor(target, key) {
      if (!paused && usage.get(owners.get(proxy) ?? "")?.enumerated.has(path)) {
        walked = target;
        walkedKey = key;
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  proxies.set(value, proxy);
  targets.set(proxy, value);
  owners.set(proxy, requestId);
  return proxy;
}

function instrumentOp(
  target: unknown[],
  op: string,
  fn: (...args: unknown[]) => unknown,
  receiver: unknown,
  requestId: string,
  path: string,
  depth: number,
) {
  return function (this: unknown, ...args: unknown[]) {
    // Detached or `.call(other)` invocations are not transforms of this list.
    if (this !== receiver) return fn.apply(this, args);
    const entry = usage.get(requestId);
    // A select component mapping the options it was given is the library's
    // work, not the app's transform chain. Decided once per op and depth.
    const opKey = `${op}${depth}`;
    let isApp = entry?.appOps.get(opKey);
    if (entry && isApp === undefined) {
      isApp = callSite() !== null;
      entry.appOps.set(opKey, isApp);
    }
    const inCount = target.length;
    const start = performance.now();
    const out = fn.apply(this, args);
    const ms = performance.now() - start;
    const isArray = Array.isArray(out);
    if (isApp && entry && entry.ops.length < INGEST_LIMITS.ops)
      entry.ops.push({
        op,
        inCount,
        outCount: isArray ? out.length : null,
        ms,
        depth,
      });
    // `sort` returns the receiver itself; only new arrays extend the chain.
    // reduce output is the caller's accumulator, not a derived list.
    return isArray && out !== receiver && op !== "reduce"
      ? wrap(out, requestId, path, depth + 1)
      : out;
  };
}

/** Retarget shared references to the latest response without changing their identity. */
export function shareTracked<T>(value: T, requestId: string): T {
  const visited = new WeakSet<object>();
  const visit = (item: unknown) => {
    if (item === null || typeof item !== "object" || visited.has(item)) return;
    visited.add(item);
    const raw = unwrap(item);
    if (!isJsonShaped(raw)) return;
    if (owners.has(item)) owners.set(item, requestId);
    const proxy = proxies.get(raw);
    if (proxy) owners.set(proxy, requestId);
    for (const child of Object.values(raw)) visit(child);
  };
  visit(value);
  return track(value, requestId);
}
