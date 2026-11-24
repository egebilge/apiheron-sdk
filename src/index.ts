import { newId, setIgnored } from "./capture";
import { instrumentClone } from "./clone";
import { diagnostics } from "./diagnostics";
import { instrumentFetch } from "./fetch";
import { setMaskFields } from "./mask";
import { setCaptureRequests, setCaptureResponses } from "./replay";
import { instrumentXhr } from "./xhr";

export { getCaptureHealth } from "./diagnostics";
export { endScenario, startScenario } from "./scenario";

import { flush } from "./transport";

export { instrumentAxios } from "./axios";
export { untracked, unwrap } from "./tracker";

export type InitOptions = {
  /** Ingest key from Workspace → Projects, e.g. "ah_ingest_…". */
  key: string;
  /** The collector's ingest URL. */
  endpoint: string;
  flushIntervalMs?: number;
  /** URL substrings to skip, e.g. `["/health", "analytics."]`. */
  ignore?: string[];
  /** Build of the app, e.g. a commit SHA; links findings and source maps to it. */
  release?: string;
  /**
   * Share of page loads to record, 0 to 1 (default 1). Decided once per page
   * load, so a recorded session stays complete and its findings hold; counts
   * then cover the sample only.
   */
  sampleRate?: number;
  /**
   * Also record each request's URL and body as sent (default false), so it can
   * be copied as cURL. Off by default: then query values and path ids are
   * hashed and no body leaves the page. Secret-like query and body fields
   * (password, token, …_key) are always masked; headers are never read.
   */
  captureRequests?: boolean;
  /**
   * With `captureRequests`, also record each JSON response as received
   * (default false), cut at 32 KB, so the dashboard can show what came back.
   * Secret-like fields are masked as in request bodies. Response values are
   * real data: turn this on only where that is acceptable.
   */
  captureResponses?: boolean;
  /**
   * Extra field names to mask in captured URLs and bodies, on top of
   * credentials (password, token, …_key) and personal values (e-mail, T.C.
   * kimlik no, card, IBAN, mobile number), which are always masked. A string
   * matches the name exactly; a RegExp is tested against it. Both see the name
   * lowercased with separators removed: `TC_Kimlik_No` is `tckimlikno`.
   */
  maskFields?: (string | RegExp)[];
};

const STARTED = Symbol.for("apiheron.started");

/**
 * Starts capture. Call once before the app's first request, e.g. at the top
 * level of Next.js `instrumentation-client.ts`; a dynamic `import()` there may
 * resolve after hydration and miss early requests. In production, lower
 * `sampleRate`: a page load that is not sampled records nothing and leaves
 * response data untouched.
 */
export function init({
  key,
  endpoint,
  flushIntervalMs = 2000,
  ignore = [],
  release,
  sampleRate = 1,
  captureRequests = false,
  captureResponses = false,
  maskFields = [],
}: InitOptions) {
  if (typeof window === "undefined") return; // SSR / tests: nothing to capture.
  const scope = globalThis as { [STARTED]?: true };
  if (scope[STARTED]) return;
  scope[STARTED] = true;
  diagnostics.initialized = true;
  diagnostics.sampled = Math.random() < sampleRate;
  if (!diagnostics.sampled) return; // NaN or 0: never recorded.

  setIgnored(ignore);
  setCaptureRequests(captureRequests);
  setCaptureResponses(captureResponses);
  setMaskFields(maskFields);
  instrumentFetch(endpoint);
  instrumentXhr(endpoint);
  instrumentClone();
  const sessionId = newId();
  setInterval(
    () => flush(endpoint, sessionId, key, false, release),
    flushIntervalMs,
  );
  addEventListener("pagehide", () =>
    flush(endpoint, sessionId, key, true, release),
  );
}
