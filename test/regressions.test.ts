import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { version } from "../package.json";
import { capture, drainRequests } from "../src/capture";
import { getCaptureHealth } from "../src/diagnostics";
import { instrumentFetch } from "../src/fetch";
import { endScenario, startScenario } from "../src/scenario";
import { instrumentQueryClient, queryAlias } from "../src/tanstack";
import { drainUsage, requestIdOf } from "../src/tracker";

const nativeFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = nativeFetch;
  drainRequests();
  drainUsage();
  endScenario();
});

function useFetch(data: () => unknown, instrumented = true) {
  globalThis.fetch = Object.assign(
    async () =>
      new Response(JSON.stringify(data()), {
        headers: { "content-type": "application/json" },
      }),
    { preconnect: () => {} },
  );
  if (instrumented) instrumentFetch("https://collector.test");
}

test("fetch preserves native consumption, clone independence and mixed readers", async () => {
  for (const instrumented of [false, true]) {
    const responseOf = () =>
      new Response('{"name":"original"}', {
        headers: { "content-type": "application/json" },
      });
    if (instrumented) useFetch(() => ({ name: "original" }));
    const response = instrumented
      ? await fetch("https://api.test")
      : responseOf();
    const clone = response.clone();
    const data = await response.json();
    expect(response.bodyUsed).toBe(true);
    data.name = "mutated";
    expect((await clone.json()).name).toBe("original");
    await expect(response.json()).rejects.toThrow();
    await expect(response.text()).rejects.toThrow();
    // Bun permits cloning a consumed in-memory Response; the SDK delegates to native clone.
    const mixed = instrumented ? await fetch("https://api.test") : responseOf();
    await mixed.arrayBuffer();
    await expect(mixed.json()).rejects.toThrow();
  }
  expect(drainRequests()).toHaveLength(1);
});

test("clone usage merges without resetting original reads", async () => {
  useFetch(() => ({ a: 1, b: 2 }));
  const response = await fetch("https://api.test");
  const clone = response.clone();
  void (await response.json()).a;
  void (await clone.json()).b;
  expect(drainRequests()).toHaveLength(1);
  expect(drainUsage()[0]?.reads).toEqual(["a", "b"]);
});

test("opaque query aliases never expose arguments and preserve equality", () => {
  const key = '["user",{"email":"private@example.com","token":"secret"}]';
  const alias = queryAlias(key);
  expect(alias).toBe(queryAlias(key));
  expect(alias).not.toContain("private");
  expect(alias).not.toContain("secret");
  expect(alias).not.toBe(queryAlias('["user",2]'));
});

test("changed and unchanged refetches preserve native sharing and record new usage", async () => {
  for (const instrumented of [false, true]) {
    let value = 1;
    useFetch(
      () => ({ changed: { value }, stable: { label: "x" } }),
      instrumented,
    );
    const client = new QueryClient();
    if (instrumented) instrumentQueryClient(client);
    const queryKey = ["refetch", instrumented];
    const queryFn = () => fetch("https://api.test/data").then((r) => r.json());
    const first = await client.fetchQuery({ queryKey, queryFn });
    const stable = first.stable;
    value = 2;
    await client.refetchQueries({ queryKey });
    const second = client.getQueryData<typeof first>(queryKey);
    expect(second).not.toBe(first);
    expect(second.stable).toBe(stable);
    expect(second.changed.value).toBe(2);
    if (instrumented) {
      const latest = drainRequests().at(-1);
      expect(requestIdOf(second)).toBe(latest?.id);
      const usage = drainUsage().find((e) => e.requestId === latest?.id);
      expect(usage?.reads).toContain("changed.value");
    }
    await client.refetchQueries({ queryKey });
    const unchanged = client.getQueryData<typeof first>(queryKey);
    expect(unchanged).toBe(second);
    void unchanged.changed.value;
    if (instrumented) {
      const latest = drainRequests().at(-1);
      expect(requestIdOf(unchanged)).toBe(latest?.id);
      expect(
        drainUsage().find((e) => e.requestId === latest?.id)?.reads,
      ).toContain("changed.value");
    }
    client.clear();
    drainRequests();
    drainUsage();
  }
});

test("scenario is captured at request start and every run has its own identity", async () => {
  useFetch(() => ({ a: 1 }));
  const run = startScenario("checkout");
  const response = await fetch("https://api.test/cart");
  endScenario();
  await response.json();
  expect(drainRequests()[0]).toMatchObject({
    scenario: "checkout",
    scenarioRunId: run,
    tracking: "tracked",
    sdkVersion: version,
  });
  expect(startScenario("checkout")).not.toBe(run);
  endScenario();
  const beforeScenario = await fetch("https://api.test/other");
  startScenario("new");
  await beforeScenario.json();
  expect(drainRequests()[0]?.scenario).toBeUndefined();
});

test("wide shapes are bounded and explicitly marked incomplete", () => {
  capture({
    source: "fetch",
    method: "GET",
    url: "https://api.test/wide",
    body: null,
    status: 200,
    start: 0,
    bytes: 1,
    data: Object.fromEntries(
      Array.from({ length: 5001 }, (_, i) => [`field${i}`, i]),
    ),
  });
  const event = drainRequests()[0];
  expect(event?.leaves.length).toBeLessThanOrEqual(5000);
  expect(event?.truncated).toBe(true);
  const health = getCaptureHealth();
  expect(health.truncated).toBeGreaterThan(0);
  health.adapters.fetch = false;
  expect(getCaptureHealth().adapters.fetch).toBe(true);
});

test("wireBytes comes from the closest resource timing entry, then content-length, and is omitted when hidden", () => {
  const native = performance.getEntriesByName;
  const entries = (sizes: number[]) =>
    ((name: string) =>
      name === "https://api.test/list"
        ? sizes.map((encodedBodySize, i) => ({
            startTime: i * 1000,
            encodedBodySize,
          }))
        : []) as unknown as typeof native;
  const send = (start: number, contentLength?: number) =>
    capture({
      source: "fetch",
      method: "GET",
      url: "https://api.test/list",
      body: null,
      status: 200,
      start,
      bytes: 1_747_000,
      contentLength,
      data: { a: 1 },
    });
  try {
    performance.getEntriesByName = entries([999, 126_000]);
    send(1001);
    expect(drainRequests()[0]?.wireBytes).toBe(126_000);
    // Cross-origin without Timing-Allow-Origin reports 0.
    performance.getEntriesByName = entries([0]);
    send(0);
    expect(drainRequests()[0]).not.toHaveProperty("wireBytes");
    // content-length stands in there, and never overrides a measured size.
    send(0, 131_000);
    expect(drainRequests()[0]?.wireBytes).toBe(131_000);
    performance.getEntriesByName = entries([999, 126_000]);
    send(1001, 131_000);
    expect(drainRequests()[0]?.wireBytes).toBe(126_000);
    performance.getEntriesByName = () => {
      throw new Error("unsupported");
    };
    send(0);
    expect(drainRequests()[0]).not.toHaveProperty("wireBytes");
  } finally {
    performance.getEntriesByName = native;
  }
});
