import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { instrumentAxios } from "../src/axios";
import {
  bodyHashOf,
  callSite,
  capture,
  drainRequests,
  setIgnored,
} from "../src/capture";
import { instrumentFetch } from "../src/fetch";
import { init } from "../src/index";
import { instrumentQueryClient, queryAlias } from "../src/tanstack";
import { drainUsage, requestIdOf } from "../src/tracker";
import { flush } from "../src/transport";

const INGEST = "http://localhost:4747/api/ingest";
const body = { total: 1, items: [{ id: 1, name: "a", secret: "x" }] };

afterEach(() => {
  drainRequests();
  drainUsage();
});

describe("request identity", () => {
  test("unreadable bodies never hash equal", () => {
    expect(bodyHashOf('{"a":1}')).toBe(bodyHashOf('{"a":1}'));
    expect(bodyHashOf(new URLSearchParams("a=1"))).toBe(bodyHashOf("a=1"));
    expect(bodyHashOf(new FormData())).not.toBe(bodyHashOf(new FormData()));
    expect(bodyHashOf(undefined)).toBeNull();
  });

  test("id-like path segments are hashed, names stay", async () => {
    const { maskPath } = await import("../src/capture");
    const a = maskPath("https://api.x:8080/users/42/by-mail/a%40b.c?x=1");
    expect(a).toMatch(
      /^https:\/\/api\.x:8080\/users\/~[0-9a-f]+\/by-mail\/~[0-9a-f]+\?x=1$/,
    );
    expect(maskPath("/orders/42")).toBe(maskPath("/orders/42"));
    expect(maskPath("/orders/42")).not.toBe(maskPath("/orders/43"));
    expect(maskPath("/get-all-users")).toBe("/get-all-users");
  });

  test("query values are hashed, keys and path stay", async () => {
    const { maskQuery } = await import("../src/capture");
    const a = maskQuery("https://api.x/users?email=a@b.c&token=s3cret#f");
    expect(a).toMatch(
      /^https:\/\/api\.x\/users\?email=[0-9a-f]+&token=[0-9a-f]+#f$/,
    );
    expect(a).not.toContain("a@b.c");
    expect(a).not.toContain("s3cret");
    expect(a).toBe(maskQuery("https://api.x/users?email=a@b.c&token=s3cret#f"));
    expect(maskQuery("https://api.x/users?a=1")).not.toBe(
      maskQuery("https://api.x/users?a=2"),
    );
    expect(maskQuery("https://api.x/users")).toBe("https://api.x/users");
    expect(maskQuery("https://api.x/u?flag")).toBe("https://api.x/u?flag");
  });

  test("dev-server internals are not captured", () => {
    const base = {
      source: "fetch" as const,
      method: "post",
      body: null,
      status: 200,
      start: 0,
      bytes: 2,
      data: {},
    };
    capture({
      ...base,
      url: "http://localhost:3001/__nextjs_original-stack-frames",
    });
    capture({ ...base, url: "http://localhost:3001/_next/data/x.json" });
    capture({ ...base, url: "http://localhost:3001/api/version?v=1" });
    setIgnored(["/health", "analytics."]);
    capture({ ...base, url: "http://localhost:3001/health" });
    capture({ ...base, url: "https://analytics.example.com/collect" });
    setIgnored([]);
    const urls = drainRequests().map((r) => r.url);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(
      /^http:\/\/localhost:3001\/api\/version\?v=[0-9a-f]+$/,
    );
  });

  test("vendor chunk frames are not call sites", async () => {
    const { isLibraryFrame } = await import("../src/capture");
    expect(
      isLibraryFrame(
        "async Axios.request (0567_axios_lib_0udcb60._.js:811:20)",
      ),
    ).toBe(true);
    expect(
      isLibraryFrame("async queryFn (packages_common_1bzbxea._.js:2948:28)"),
    ).toBe(false);
    expect(
      isLibraryFrame(
        "getUsers (packages_common_auth_src_axios-service.ts:4:1)",
      ),
    ).toBe(false);
  });

  test("call site keeps the app frame and drops the SDK's", () => {
    // Function names depend on the engine inlining; the file is stable.
    const site = callSite();
    expect(site).toMatch(/^[^/]*adapters\.test\.ts:\d+:\d+/m);
    expect(site).not.toContain("capture.ts");
  });
});

describe("instrumentFetch", () => {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      const isHtml = url.includes("/html");
      if (url.includes("/empty")) {
        return new Response("", { headers: { "content-type": "json" } });
      }
      if (url.includes("/sized")) {
        const response = new Response(JSON.stringify(body), {
          headers: { "content-type": "json", "content-length": "7" },
        });
        return Object.defineProperty(response, "type", { value: "basic" });
      }
      return new Response(isHtml ? "<p>" : JSON.stringify(body), {
        headers: {
          "content-type": isHtml
            ? "text/html"
            : "application/json; charset=utf-8",
        },
      });
    },
    { preconnect: () => {} },
  );
  instrumentFetch(INGEST);
  instrumentFetch(INGEST); // idempotent across HMR

  test("captures json responses and tracks reads", async () => {
    const response = await fetch("http://api.test/users/42?page=1", {
      method: "post",
    });
    const data = await response.json();
    void data.items[0].name;

    const [event] = drainRequests();
    expect(event).toMatchObject({
      source: "fetch",
      method: "POST",
      route: "api.test/users/:id?page",
      status: 200,
      bytes: JSON.stringify(body).length,
      itemCount: 1,
    });
    expect(event?.leaves.sort()).toEqual([
      "items[].id",
      "items[].name",
      "items[].secret",
      "total",
    ]);
    expect(requestIdOf(data)).toBe(event?.id);
    expect(event?.initiator).toContain("adapters.test.ts");
    expect(drainUsage()[0]?.reads).toEqual([
      "items",
      "items[]",
      "items[].name",
    ]);
  });

  test("passes through ingest and non-json responses", async () => {
    await (await fetch(INGEST, { method: "POST" })).text();
    await (await fetch("http://api.test/html")).text();
    expect(drainRequests()).toEqual([]);
  });

  test("invalid json still rejects like native response.json()", async () => {
    const response = await fetch("http://api.test/empty");
    expect(response.json()).rejects.toThrow(SyntaxError);
  });

  test("an internal failure hands the app the raw data", async () => {
    const data = await withBrokenLocation(async () =>
      (await fetch("http://api.test/items")).json(),
    );
    expect(data).toEqual(body);
    expect(requestIdOf(data)).toBeUndefined();
  });

  test("clone().json() is captured and tracked", async () => {
    const data = await (await fetch("http://api.test/items")).clone().json();
    void data.total;

    const [event] = drainRequests();
    expect(event?.leaves).toContain("total");
    expect(requestIdOf(data)).toBe(event?.id);
    expect(drainUsage()[0]?.reads).toEqual(["total"]);
  });

  test("text() parsed by the app is tracked", async () => {
    const response = await fetch("http://api.test/items");
    const data = JSON.parse(await response.text());
    void data.total;

    const events = drainRequests();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tracking: "tracked",
      itemCount: 1,
      bytes: JSON.stringify(body).length,
    });
    expect(events[0]?.leaves).toContain("total");
    expect(drainUsage()[0]?.reads).toEqual(["total"]);
  });

  test("text() nobody parses makes no field-usage claim", async () => {
    await (await fetch("http://api.test/items")).text();
    expect(drainRequests()[0]).toMatchObject({
      tracking: "untracked",
      leaves: [],
    });
    // A later parse of the same text is the app's own object.
    expect(requestIdOf(JSON.parse(JSON.stringify(body)))).toBeUndefined();
  });

  test("SDK trouble before the request never rejects the app's fetch", async () => {
    const now = performance.now;
    performance.now = () => {
      performance.now = now;
      throw new Error("sdk bug");
    };
    const response = await fetch("http://api.test/items");
    expect(await response.json()).toEqual(body);
  });

  test("json() on the original and a clone records one request", async () => {
    const response = await fetch("http://api.test/items");
    const clone = response.clone();
    expect(await clone.json()).toEqual(await response.json());
    expect(drainRequests()).toHaveLength(1);
  });

  test("uses content-length for same-origin uncompressed bodies", async () => {
    await (await fetch("http://api.test/sized")).json();
    expect(drainRequests()[0]?.bytes).toBe(7);
  });

  test("works without crypto.randomUUID (insecure origin)", async () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    try {
      await (await fetch("http://api.test/items")).json();
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        value: original,
        configurable: true,
      });
    }
    expect(drainRequests()[0]?.id).toBeString();
  });
});

/** Makes every `location` read throw, i.e. an SDK-internal failure inside capture. */
async function withBrokenLocation<T>(fn: () => T | Promise<T>): Promise<T> {
  Object.defineProperty(globalThis, "location", {
    get: () => {
      throw new Error("boom");
    },
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    delete (globalThis as { location?: unknown }).location;
  }
}

function axiosInstance() {
  const requests: ((c: object) => object)[] = [];
  const responses: ((r: never) => unknown)[] = [];
  instrumentAxios({
    interceptors: {
      request: { use: (fn: (c: object) => object) => requests.push(fn) },
      response: { use: (fn: (r: never) => unknown) => responses.push(fn) },
    },
  });
  return {
    request: (config: object) => requests[0]?.(config),
    respond: (response: object) =>
      responses[0]?.(response as never) as { data: unknown },
  };
}

describe("instrumentAxios", () => {
  test("wraps response.data before app interceptors run", () => {
    const { request, respond } = axiosInstance();
    const config = request({
      baseURL: "http://api.test/v1/",
      url: "/items",
      method: "get",
      params: { q: "x" },
    });
    const response = respond({
      data: structuredClone(body),
      status: 200,
      config,
      request: { responseText: JSON.stringify(body) },
    }) as { data: typeof body };
    void response.data.total;

    const [event] = drainRequests();
    expect(event).toMatchObject({
      source: "axios",
      method: "GET",
      route: "api.test/v1/items?q",
    });
    expect(event?.url).toMatch(/^http:\/\/api\.test\/v1\/items\?q=[0-9a-f]+$/);
    expect(drainUsage()[0]?.reads).toEqual(["total"]);
  });

  test("leaves blob/arraybuffer responses untouched", () => {
    const { request, respond } = axiosInstance();
    // XHR throws InvalidStateError on responseText for non-text responseType.
    const xhr = {
      get responseText(): string {
        throw new DOMException("not text", "InvalidStateError");
      },
    };
    for (const responseType of ["blob", "arraybuffer", "document"]) {
      const data = new Blob(["x"]);
      const config = request({ url: "http://api.test/file", responseType });
      const response = respond({ data, status: 200, config, request: xhr });
      expect(response.data).toBe(data);
    }
    expect(drainRequests()).toEqual([]);
  });

  test("tolerates a missing config", () => {
    const { respond } = axiosInstance();
    const data = { a: 1 };
    expect(respond({ data, status: 200 }).data).toBe(data);
  });

  test("an internal failure hands the app the raw data", async () => {
    const { request, respond } = axiosInstance();
    const data = { a: 1 };
    const config = request({ url: "/items" });
    const response = await withBrokenLocation(() =>
      respond({ data, status: 200, config }),
    );
    expect(response.data).toBe(data);
  });
});

describe("init", () => {
  test("no-ops outside a browser", () => {
    init({ key: "k", endpoint: "http://localhost/api/ingest" });
    expect(
      (globalThis as Record<symbol, unknown>)[Symbol.for("apiheron.started")],
    ).toBeUndefined();
  });
});

describe("flush", () => {
  test("splits unload payloads under the beacon limit", async () => {
    for (let i = 0; i < 200; i++) {
      capture({
        source: "fetch",
        method: "get",
        url: `http://api.test/${"x".repeat(1000)}/${i}`,
        body: null,
        status: 200,
        start: 0,
        bytes: 0,
        data: {},
      });
    }
    const beacons: Blob[] = [];
    const original = navigator.sendBeacon;
    Object.defineProperty(navigator, "sendBeacon", {
      value: (_url: string, blob: Blob) => beacons.push(blob) > 0,
      configurable: true,
    });
    try {
      await flush(INGEST, "session", "ah_ingest_test", true);
    } finally {
      Object.defineProperty(navigator, "sendBeacon", {
        value: original,
        configurable: true,
      });
    }
    expect(beacons.every((b) => b.size < 60_000)).toBe(true);
    const sent = await Promise.all(
      beacons.map(async (b) => JSON.parse(await b.text())),
    );
    expect(sent.flatMap((batch) => batch.events)).toHaveLength(200);
  });
});

describe("instrumentQueryClient", () => {
  test("structural sharing is not counted as reads and the query hash is linked", async () => {
    const client = new QueryClient();
    instrumentQueryClient(client);
    const queryFn = async () => (await fetch("http://api.test/items")).json();

    await client.fetchQuery({ queryKey: ["items"], queryFn });
    await client.refetchQueries({ queryKey: ["items"] });

    const [first, second] = drainRequests();
    const usage = drainUsage();
    expect(usage.every((e) => e.reads.length === 0)).toBe(true);
    expect(usage.map((e) => [e.requestId, e.queryKey])).toEqual([
      [first?.id, queryAlias('["items"]')],
      [second?.id, queryAlias('["items"]')],
    ]);
  });
});
