import { bodyBytes, callSite, capture } from "./capture";
import { diagnostics } from "./diagnostics";
import { currentScenario, type Scenario } from "./scenario";
import { capturedXhr } from "./xhr";

// Structural types so the SDK does not depend on axios.
type Config = {
  url?: string;
  baseURL?: string;
  method?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  responseType?: string;
  [START]?: number;
  [SCENARIO]?: Scenario | null;
  [INITIATOR]?: string | null;
};
type Response = {
  data: unknown;
  status: number;
  config: Config;
  headers?: Record<string, unknown>;
  request?: object & { responseText?: unknown };
};
type AxiosLike = {
  interceptors: {
    request: { use(onFulfilled: (config: Config) => Config): number };
    response: { use(onFulfilled: (response: Response) => Response): number };
  };
};

const SCENARIO = Symbol.for("apiheron.scenario");
const patched = new WeakSet<object>();

const START = Symbol.for("apiheron.start");
const INITIATOR = Symbol.for("apiheron.initiator");

/**
 * Captures JSON responses of an axios instance. Call right after
 * `axios.create()`: response interceptors run in registration order, and an
 * app interceptor that unwraps `response.data` must run after this one.
 */
export function instrumentAxios(instance: AxiosLike) {
  if (patched.has(instance)) return;
  patched.add(instance);
  diagnostics.adapters.axios = true;
  instance.interceptors.request.use((config) => {
    config[START] = performance.now();
    config[SCENARIO] = currentScenario() ?? null;
    config[INITIATOR] = callSite();
    return config;
  });
  instance.interceptors.response.use((response) => {
    const { config, data } = response;
    // An earlier app interceptor may have unwrapped data already.
    if (!config || data === null || typeof data !== "object") return response;
    // The XHR adapter recorded it and axios parsed the tracked body already.
    if (response.request && capturedXhr.has(response.request)) return response;
    // Blob/arraybuffer/document/stream are not parsed JSON, and XHR throws
    // InvalidStateError on responseText for them.
    const { responseType } = config;
    if (responseType && responseType !== "json") return response;
    try {
      const url = axiosUrl(config);
      const headers = response.headers ?? {};
      const text = response.request?.responseText;
      response.data = capture({
        source: "axios",
        scenario: config[SCENARIO],
        method: config.method ?? "get",
        url,
        // transformRequest has already serialized it by response time.
        body: config.data,
        status: response.status,
        start: config[START] ?? performance.now(),
        bytes:
          typeof text === "string"
            ? bodyBytes(
                text,
                { get: (name) => headers[name] },
                new URL(url).origin === globalThis.location?.origin,
              )
            : Number(headers["content-length"] ?? 0),
        data,
        initiator: config[INITIATOR],
      });
    } catch {
      // Never break the app: it gets the raw data.
    }
    return response;
  });
}

function axiosUrl({ url = "", baseURL, params }: Config): string {
  // Mirrors axios combineURLs: absolute url wins, otherwise join with one slash.
  const full =
    baseURL && !/^([a-z][a-z\d+\-.]*:)?\/\//i.test(url)
      ? `${baseURL.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`
      : url;
  const parsed = new URL(full, globalThis.location?.href ?? "http://localhost");
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) parsed.searchParams.append(key, String(value));
  }
  return parsed.href;
}
