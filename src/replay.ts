import { INGEST_LIMITS } from "./core/limits";
import { isSecretName } from "./core/secrets";
import { nativeParse } from "./parse";

/** Stands in for a value whose name looks like a credential. */
export const MASK = "***";

/** `init({ captureRequests })`: off unless the app opts in. */
let enabled = false;
export const setCaptureRequests = (on: boolean) => {
  enabled = on;
};

export type Replay = {
  url: string;
  body: string | null;
  omitted?: "unreadable" | "too-large";
};

const maskParams = (params: URLSearchParams) => {
  const masked = new URLSearchParams();
  for (const [key, value] of params)
    masked.append(key, isSecretName(key) ? MASK : value);
  return masked.toString();
};

/** Recursively replaces values under secret-like keys; arrays keep their order. */
export function maskJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      isSecretName(key) ? MASK : maskJson(inner),
    ]),
  );
}

const URL_ENCODED = /^[^=&\s]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*$/;

function bodyText(body: unknown): string | null | undefined {
  if (body === undefined || body === null || body === "") return null;
  if (typeof body === "string") {
    try {
      return JSON.stringify(maskJson(nativeParse(body)));
    } catch {
      return URL_ENCODED.test(body)
        ? maskParams(new URLSearchParams(body))
        : body;
    }
  }
  if (body instanceof URLSearchParams) return maskParams(body);
  const plain =
    Array.isArray(body) ||
    (typeof body === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(body)));
  // axios hands over the object before serializing it.
  if (plain) return JSON.stringify(maskJson(body));
  return undefined; // FormData, Blob, ArrayBuffer, streams.
}

/**
 * The request as the app sent it, for "Copy as cURL". Headers are never read,
 * so an Authorization token cannot leak; secret-like query and body fields are
 * masked. Null unless `captureRequests` is on.
 */
export function replayOf(url: string, body: unknown): Replay | null {
  if (!enabled) return null;
  let href: string;
  try {
    const parsed = new URL(url, globalThis.location?.href);
    parsed.search = maskParams(parsed.searchParams);
    href = parsed.href.slice(0, INGEST_LIMITS.replayUrlLength);
  } catch {
    return null;
  }
  let text: string | null | undefined;
  try {
    text = bodyText(body);
  } catch {
    text = undefined;
  }
  if (text === undefined)
    return { url: href, body: null, omitted: "unreadable" };
  if (text !== null && text.length > INGEST_LIMITS.replayBodyLength)
    return { url: href, body: null, omitted: "too-large" };
  return { url: href, body: text };
}
