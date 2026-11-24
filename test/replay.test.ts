import { afterEach, expect, test } from "bun:test";
import { INGEST_LIMITS } from "../src/core/limits";
import { capture, drainRequests } from "../src/capture";
import {
  boundedJson,
  MASK,
  replayOf,
  setCaptureRequests,
  setCaptureResponses,
} from "../src/replay";

afterEach(() => {
  setCaptureRequests(false);
  drainRequests();
});

const base = {
  source: "fetch" as const,
  status: 200,
  start: 0,
  bytes: 2,
  data: {},
};

test("off by default: no replay, URL values stay hashed", () => {
  capture({
    ...base,
    method: "POST",
    url: "https://api.test/a?id=7",
    body: "{}",
  });
  const [event] = drainRequests();
  expect(event?.replay).toBeUndefined();
  expect(event?.url).not.toContain("id=7");
});

test("on: real URL and body, secret-like names masked", () => {
  setCaptureRequests(true);
  capture({
    ...base,
    method: "POST",
    url: "https://api.test/users/42?page=2&access_token=abc",
    body: JSON.stringify({
      name: "Ada",
      password: "x",
      nested: [{ apiKey: "k", sortKey: "s" }],
    }),
  });
  const [event] = drainRequests();
  expect(event?.replay?.url).toBe(
    "https://api.test/users/42?page=2&access_token=***",
  );
  expect(JSON.parse(event?.replay?.body ?? "")).toEqual({
    name: "Ada",
    password: MASK,
    nested: [{ apiKey: MASK, sortKey: "s" }],
  });
});

test("axios objects and urlencoded strings are masked too", () => {
  setCaptureRequests(true);
  expect(replayOf("https://api.test", { user: "a", Sifre: "b" })?.body).toBe(
    '{"user":"a","Sifre":"***"}',
  );
  expect(replayOf("https://api.test", "user=a&pwd=b")?.body).toBe(
    "user=a&pwd=***",
  );
  expect(
    replayOf("https://api.test", new URLSearchParams("token=t"))?.body,
  ).toBe("token=***");
});

test("unreadable and oversized bodies are dropped with a reason", () => {
  setCaptureRequests(true);
  expect(replayOf("https://api.test", new Blob(["x"]))).toEqual({
    url: "https://api.test/",
    body: null,
    omitted: "unreadable",
  });
  const big = "x".repeat(INGEST_LIMITS.replayBodyLength + 1);
  expect(replayOf("https://api.test", big)?.omitted).toBe("too-large");
  expect(replayOf("https://api.test", undefined)?.body).toBeNull();
});

test("captureResponses: masked JSON response, cut at the limit", () => {
  setCaptureRequests(true);
  setCaptureResponses(true);
  capture({
    ...base,
    method: "GET",
    url: "https://api.test/me",
    body: null,
    data: { name: "Ada", token: "t", list: [1, null], skip: undefined },
  });
  const [event] = drainRequests();
  expect(event?.replay?.response).toEqual({
    body: '{"name":"Ada","token":"***","list":[1,null]}',
  });
  const big = { rows: Array.from({ length: 10_000 }, (_, i) => ({ i })) };
  const cut = boundedJson(big, INGEST_LIMITS.replayResponseLength);
  expect(cut.truncated).toBe(true);
  expect(cut.body.length).toBe(INGEST_LIMITS.replayResponseLength);
  expect(JSON.stringify(big).startsWith(cut.body)).toBe(true);
  setCaptureResponses(false);
});

test("captureResponses needs captureRequests", () => {
  setCaptureResponses(true);
  capture({ ...base, method: "GET", url: "https://api.test/me", body: null });
  expect(drainRequests()[0]?.replay).toBeUndefined();
  setCaptureResponses(false);
});
