import { bodyBytes, callSite, capture, captureLazy } from "./capture";
import { diagnostics } from "./diagnostics";
import { expectParse, installParse, nativeParse } from "./parse";
import { currentScenario, type Scenario } from "./scenario";
import { requestIdOf, track } from "./tracker";

const PATCHED = Symbol.for("apiheron.fetch");

/** Shared by a response and its clones: one logical response is captured once. */
type Ctx = {
  method: string;
  url: string;
  body: unknown;
  start: number;
  initiator: string | null;
  downloaded: Promise<{ text: string; end: number } | null>;
  captured?: boolean;
  /** Clones share telemetry identity, but parse into independent objects. */
  requestId?: string;
  scenario: Scenario | null;
};

/** Patches `globalThis.fetch` so JSON bodies read via `response.json()` are captured. Requests to `skipPrefix` pass through. */
export function instrumentFetch(skipPrefix: string) {
  const original = globalThis.fetch as typeof fetch & { [PATCHED]?: true };
  if (original[PATCHED]) return;
  diagnostics.adapters.fetch = true;
  installParse();

  const patched = async (input: RequestInfo | URL, init?: RequestInit) => {
    // SDK code never decides whether the app's request succeeds: anything
    // thrown before or after the native call falls back to the native result.
    let before: Omit<Ctx, "downloaded"> | null = null;
    try {
      before = prepare(input, init, skipPrefix);
    } catch {
      diagnostics.errors += 1;
    }
    const response = await original(input, init);
    if (!before) return response;
    try {
      if (!response.headers.get("content-type")?.includes("json"))
        return response;

      // Time the download itself: the app may call json() much later, and that
      // wait is not the API's latency.
      const downloaded = response
        .clone()
        .text()
        .then((text) => ({ text, end: performance.now() }))
        .catch(() => null);

      return instrument(response, { ...before, downloaded });
    } catch {
      diagnostics.errors += 1;
      return response;
    }
  };

  globalThis.fetch = Object.assign(patched, original, {
    [PATCHED]: true as const,
  });
}

/** Everything read from the request before it is sent; null when it is the SDK's own traffic. */
function prepare(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  skipPrefix: string,
): Omit<Ctx, "downloaded"> | null {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith(skipPrefix)) return null;
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  // A Request object carries its body inside; it can't be read without
  // consuming it, so it counts as an opaque (unique) payload.
  const body =
    init?.body ??
    (input instanceof Request && input.body !== null ? input.body : undefined);
  return {
    method,
    url,
    body,
    initiator: callSite(),
    start: performance.now(),
    scenario: currentScenario() ?? null,
  };
}

/** Overrides `json`, `text` and `clone` so every way of reading the body is seen. */
function instrument(response: Response, ctx: Ctx): Response {
  const nativeText = response.text;
  const nativeClone = response.clone;
  const read = async () => {
    // Consume this response, preserving bodyUsed, stream locks and repeat-read errors.
    const text = await nativeText.call(response);
    const done = await ctx.downloaded;
    return { text, end: done?.end };
  };
  const fields = (text: string, end: number | undefined) => ({
    source: "fetch" as const,
    scenario: ctx.scenario,
    method: ctx.method,
    url: response.url || ctx.url,
    body: ctx.body,
    status: response.status,
    start: ctx.start,
    end,
    bytes: bodyBytes(text, response.headers, response.type === "basic"),
    initiator: ctx.initiator,
  });

  response.json = async () => {
    const { text, end } = await read();
    // Parse errors reject exactly like native `response.json()`.
    const data = JSON.parse(text);
    if (ctx.captured) {
      try {
        return ctx.requestId ? track(data, ctx.requestId) : data;
      } catch {
        return data;
      }
    }
    ctx.captured = true;
    try {
      const tracked = capture({ ...fields(text, end), data });
      ctx.requestId = requestIdOf(tracked);
      return tracked;
    } catch {
      return data;
    }
  };

  // The app parses the text itself (ky, ofetch, superjson): reads are tracked
  // only if that text reaches JSON.parse; timing, size and shape always count.
  response.text = async () => {
    const { text, end } = await read();
    if (!ctx.captured) {
      ctx.captured = true;
      try {
        expectParse(
          text,
          captureLazy({ ...fields(text, end), data: nativeParse(text) }),
        );
      } catch {
        // Not JSON after all: nothing to record.
      }
    }
    return text;
  };

  response.clone = () => instrument(nativeClone.call(response), ctx);
  return response;
}
