import {
  bodyBytes,
  byteLength,
  callSite,
  captureLazy,
  contentLengthOf,
} from "./capture";
import { diagnostics } from "./diagnostics";
import { expectParse, installParse, nativeParse } from "./parse";
import { currentScenario, type Scenario } from "./scenario";

const PATCHED = Symbol.for("apiheron.xhr");

type Meta = {
  method: string;
  url: string;
  body: unknown;
  start: number;
  initiator: string | null;
  scenario: Scenario | null;
};
const metas = new WeakMap<XMLHttpRequest, Meta>();
/** Requests recorded here; the axios interceptor skips them. */
export const capturedXhr = new WeakSet<object>();

/**
 * Patches `XMLHttpRequest` so axios, jQuery and Angular are captured without
 * wiring. Only text and json response types are touched: blob, arraybuffer and
 * document throw on `responseText`.
 */
export function instrumentXhr(skipPrefix: string) {
  const Xhr = globalThis.XMLHttpRequest;
  if (!Xhr) return;
  const proto = Xhr.prototype as XMLHttpRequest & { [PATCHED]?: true };
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;
  diagnostics.adapters.xhr = true;
  installParse();
  const { open, send } = proto;

  proto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    try {
      const url = new URL(
        String(args[1]),
        globalThis.location?.href ?? "http://localhost",
      ).href;
      if (url.startsWith(skipPrefix)) metas.delete(this);
      else {
        // Registered at open, before the app's handlers: the proxy must be
        // ready when they parse the body.
        this.addEventListener("load", onLoad);
        metas.set(this, {
          method: String(args[0]),
          url,
          body: undefined,
          start: performance.now(),
          initiator: null,
          scenario: null,
        });
      }
    } catch {
      diagnostics.errors += 1;
    }
    return open.apply(this, args as Parameters<typeof open>);
  };

  proto.send = function (this: XMLHttpRequest, body) {
    try {
      const meta = metas.get(this);
      if (meta) {
        meta.body = body ?? undefined;
        meta.initiator = callSite();
        meta.scenario = currentScenario() ?? null;
        meta.start = performance.now();
      }
    } catch {
      diagnostics.errors += 1;
    }
    return send.call(this, body);
  };
}

function onLoad(this: XMLHttpRequest) {
  try {
    const meta = metas.get(this);
    const type = this.responseType;
    if (!meta || (type !== "" && type !== "text" && type !== "json")) return;
    if (!this.getResponseHeader("content-type")?.includes("json")) return;
    const headers = { get: (name: string) => this.getResponseHeader(name) };
    const sameOrigin = new URL(meta.url).origin === globalThis.location?.origin;
    const fields = {
      ...meta,
      source: "xhr" as const,
      url: this.responseURL || meta.url,
      status: this.status,
      contentLength: contentLengthOf(headers),
    };

    if (type === "json") {
      const data: unknown = this.response;
      if (data === null || typeof data !== "object") return;
      const length = Number(headers.get("content-length"));
      const adopt = captureLazy({
        ...fields,
        data,
        // Cross-origin hides content-encoding, so the length may be compressed.
        bytes:
          sameOrigin && !headers.get("content-encoding") && length > 0
            ? length
            : byteLength(JSON.stringify(data)),
      });
      Object.defineProperty(this, "response", {
        configurable: true,
        get: adopt,
      });
    } else {
      const text = this.responseText;
      const adopt = captureLazy({
        ...fields,
        data: nativeParse(text),
        bytes: bodyBytes(text, headers, sameOrigin),
      });
      expectParse(text, adopt);
    }
    capturedXhr.add(this);
  } catch {
    // Not JSON after all, or SDK trouble: the app reads the response as usual.
  }
}
