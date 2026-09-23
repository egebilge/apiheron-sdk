import { newId, setIgnored } from "./capture";
import { diagnostics } from "./diagnostics";
import { instrumentFetch } from "./fetch";
import { setCaptureRequests } from "./replay";
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
};

const STARTED = Symbol.for("apiheron.started");

/**
 * Starts capture. Load in development only, e.g. in `instrumentation-client.ts`:
 * `import("@apiheron/sdk").then((v) => v.init({ key, endpoint: "https://apiheron.example.com/api/ingest" }))`
 */
export function init({
  key,
  endpoint,
  flushIntervalMs = 2000,
  ignore = [],
  release,
  sampleRate = 1,
  captureRequests = false,
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
  instrumentFetch(endpoint);
  instrumentXhr(endpoint);
  const sessionId = newId();
  setInterval(
    () => flush(endpoint, sessionId, key, false, release),
    flushIntervalMs,
  );
  addEventListener("pagehide", () =>
    flush(endpoint, sessionId, key, true, release),
  );
}
