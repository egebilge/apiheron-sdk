// Runtime-safe for the browser: no zod, no Node APIs. The SDK imports this file.

import { INGEST_LIMITS } from "./limits";

export type Shape = {
  leaves: string[];
  itemCount: number | null;
  truncated?: boolean;
};

const MAX_DEPTH = 8;
const ARRAY_SAMPLE = 20;

export const joinPath = (path: string, key: string) =>
  path ? `${path}.${key}` : key;

/**
 * Leaf paths of a parsed JSON value. Array indices collapse to `[]`, so a list
 * of users yields `users[].name`. Empty arrays and objects count as leaves.
 */
export function shapeOf(value: unknown): Shape {
  const leaves = new Set<string>();
  const state = { truncated: false };
  walk(value, "", 0, leaves, state);
  return {
    leaves: [...leaves],
    itemCount: itemCountOf(value),
    ...(state.truncated ? { truncated: true } : {}),
  };
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  out: Set<string>,
  state: { truncated: boolean },
) {
  if (
    path.length > INGEST_LIMITS.pathLength ||
    out.size >= INGEST_LIMITS.leaves
  ) {
    state.truncated = true;
    return;
  }
  if (depth > MAX_DEPTH) {
    out.add(path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (path.length + 2 > INGEST_LIMITS.pathLength) state.truncated = true;
      else out.add(`${path}[]`);
    }
    for (const item of value.slice(0, ARRAY_SAMPLE)) {
      walk(item, `${path}[]`, depth + 1, out, state);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) out.add(path);
    for (const key of keys) {
      if (out.size >= INGEST_LIMITS.leaves) {
        state.truncated = true;
        break;
      }
      walk(
        (value as Record<string, unknown>)[key],
        joinPath(path, key),
        depth + 1,
        out,
        state,
      );
    }
    return;
  }
  out.add(path);
}

/**
 * Length of the response list: the root array, or the longest top-level array
 * field. Envelopes often carry an empty `errors`/`messageList` before the data.
 */
function itemCountOf(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (value === null || typeof value !== "object") return null;
  const lengths = Object.values(value)
    .filter(Array.isArray)
    .map((list) => list.length);
  return lengths.length ? Math.max(...lengths) : null;
}

// Long tokens count as ids only when they contain a digit, so readable names
// like `get-all-users-by-company` stay separate endpoints. An email address in
// the path identifies a person, so it is an id too.
const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[\w-]*\d)[\w-]{24,}|.*(@|%40).*)$/i;

export const isIdSegment = (segment: string) => ID_SEGMENT.test(segment);

/**
 * Groups URLs into one endpoint: id-like path segments become `:id`, query
 * values are dropped and keys sorted. `api.x.com/users/42?b=1&a=2` becomes
 * `api.x.com/users/:id?a&b`.
 */
export function normalizeRoute(url: string, base = "http://localhost"): string {
  const parsed = new URL(url, base);
  const path = parsed.pathname
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
  const keys = [...new Set(parsed.searchParams.keys())].sort();
  return `${parsed.host}${path}${keys.length ? `?${keys.join("&")}` : ""}`;
}
