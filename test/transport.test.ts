import { expect, test } from "bun:test";
import { pauseFrom } from "../src/transport";

const response = (status: number, retryAfter?: string) => ({
  status,
  headers: new Headers(retryAfter ? { "retry-after": retryAfter } : {}),
});

test("a 429 pauses sending for Retry-After, capped at an hour", () => {
  const now = Date.now();
  expect(pauseFrom(response(204))).toBeNull();
  expect(pauseFrom(response(429, "30"))).toBeGreaterThanOrEqual(now + 30_000);
  // Quota resets can be weeks away; the tab retries hourly instead.
  const month = pauseFrom(response(429, String(20 * 24 * 3600))) ?? 0;
  expect(month - now).toBeLessThanOrEqual(60 * 60 * 1000 + 50);
  // Missing or unreadable header: one minute.
  expect((pauseFrom(response(429)) ?? 0) - now).toBeGreaterThanOrEqual(60_000);
});

test("invalid events are isolated, 429 stops the batch loop, and unsent work is bounded/retried", async () => {
  const { capture, drainRequests } = await import("../src/capture");
  const { drainUsage } = await import("../src/tracker");
  const { flush } = await import("../src/transport");
  const { getCaptureHealth } = await import("../src/diagnostics");
  drainRequests();
  drainUsage();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = originalNow() + 86_400_000;
  Date.now = () => now;
  const batches: { events: { id: string }[] }[] = [];
  let status = 429;
  globalThis.fetch = Object.assign(
    async (_url: unknown, init: RequestInit | undefined) => {
      if (!(init?.body instanceof Blob))
        throw new Error("expected telemetry blob");
      batches.push(JSON.parse(await init.body.text()));
      return new Response(null, { status, headers: { "retry-after": "1" } });
    },
    { preconnect: () => {} },
  );
  const add = (bytes = 1) =>
    capture({
      source: "fetch",
      method: "GET",
      url: "https://api.test/x",
      status: 200,
      start: 0,
      body: null,
      bytes,
      data: {},
    });
  try {
    const before = getCaptureHealth();
    add(Number.NaN);
    for (let i = 0; i < 600; i++) add();
    await flush("https://collector.test", "session", "key");
    expect(batches).toHaveLength(1);
    expect(getCaptureHealth().dropped).toBe(before.dropped + 1);
    expect(getCaptureHealth().queued).toBe(600);
    await flush("https://collector.test", "session", "key");
    expect(batches).toHaveLength(1);
    now += 2000;
    status = 204;
    await flush("https://collector.test", "session", "key");
    expect(batches).toHaveLength(3);
    expect(getCaptureHealth().queued).toBe(0);
    expect(getCaptureHealth().retried - before.retried).toBe(500);
    expect(getCaptureHealth().sent - before.sent).toBe(600);
    expect(batches[0]?.events[0]?.id).toBe(batches[1]?.events[0]?.id);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});
