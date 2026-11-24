import { INGEST_LIMITS } from "./core/limits";
import { isMaskedName, isPersonalValue, MASK } from "./mask";
import { nativeParse } from "./parse";

export { MASK };

/** `init({ captureRequests })`: off unless the app opts in. */
let enabled = false;
export const setCaptureRequests = (on: boolean) => {
  enabled = on;
};

/** `init({ captureResponses })`: off unless the app opts in; needs `captureRequests`. */
let responses = false;
export const setCaptureResponses = (on: boolean) => {
  responses = on;
};

export type Replay = {
  url: string;
  body: string | null;
  omitted?: "unreadable" | "too-large";
  response?: { body: string; truncated?: boolean };
};

const STOP = Symbol("stop");

/**
 * `JSON.stringify(maskJson(value))`, but it stops writing at `limit`
 * characters, so a 5 MB list costs no more than its first 32 KB.
 */
export function boundedJson(value: unknown, limit: number) {
  let out = "";
  let truncated = false;
  const write = (text: string) => {
    if (out.length + text.length > limit) {
      out += text.slice(0, limit - out.length);
      truncated = true;
      throw STOP;
    }
    out += text;
  };
  const walk = (inner: unknown): void => {
    if (Array.isArray(inner)) {
      write("[");
      inner.forEach((item, i) => {
        if (i) write(",");
        walk(item === undefined ? null : item);
      });
      write("]");
    } else if (inner !== null && typeof inner === "object") {
      write("{");
      let first = true;
      for (const [key, item] of Object.entries(inner)) {
        if (item === undefined || typeof item === "function") continue;
        if (!first) write(",");
        first = false;
        write(`${JSON.stringify(key)}:`);
        if (isMaskedName(key)) write(JSON.stringify(MASK));
        else walk(item);
      }
      write("}");
    } else
      write(
        isPersonalValue(inner)
          ? JSON.stringify(MASK)
          : (JSON.stringify(inner) ?? "null"),
      );
  };
  try {
    walk(value);
  } catch (error) {
    if (error !== STOP) throw error;
  }
  return { body: out, truncated };
}

const maskParams = (params: URLSearchParams) => {
  const masked = new URLSearchParams();
  for (const [key, value] of params)
    masked.append(
      key,
      isMaskedName(key) || isPersonalValue(value) ? MASK : value,
    );
  return masked.toString();
};

/**
 * Recursively replaces values under secret-like or `maskFields` keys, and
 * values that identify a person; arrays keep their order.
 */
export function maskJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskJson);
  if (value === null || typeof value !== "object")
    return isPersonalValue(value) ? MASK : value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      isMaskedName(key) ? MASK : maskJson(inner),
    ]),
  );
}

const decode = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

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
 * so an Authorization token cannot leak; secret-like and `maskFields` names
 * and personal values (e-mail, T.C. kimlik no, card, IBAN, mobile number)
 * are masked in the path, query and body. Null unless `captureRequests` is on; with `captureResponses` it
 * also carries the parsed JSON response, masked the same way.
 */
export function replayOf(
  url: string,
  body: unknown,
  data?: unknown,
): Replay | null {
  if (!enabled) return null;
  let href: string;
  try {
    const parsed = new URL(url, globalThis.location?.href);
    parsed.search = maskParams(parsed.searchParams);
    // `/guests/12345678950` or `/users/a@b.com`: an id that is personal data.
    parsed.pathname = parsed.pathname
      .split("/")
      .map((segment) => (isPersonalValue(decode(segment)) ? MASK : segment))
      .join("/");
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
  const replay: Replay =
    text === undefined
      ? { url: href, body: null, omitted: "unreadable" }
      : text !== null && text.length > INGEST_LIMITS.replayBodyLength
        ? { url: href, body: null, omitted: "too-large" }
        : { url: href, body: text };
  if (responses && data !== undefined) {
    try {
      const { body: response, truncated } = boundedJson(
        data,
        INGEST_LIMITS.replayResponseLength,
      );
      replay.response = truncated
        ? { body: response, truncated }
        : { body: response };
    } catch {
      // A getter that throws: keep the request without its response.
    }
  }
  return replay;
}
