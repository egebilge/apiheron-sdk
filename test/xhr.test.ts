import { afterEach, describe, expect, test } from "bun:test";
import { drainRequests } from "../src/capture";
import { drainUsage, requestIdOf } from "../src/tracker";
import { instrumentXhr } from "../src/xhr";

const INGEST = "http://localhost:4747/api/ingest";
const body = { total: 1, items: [{ id: 1, name: "a" }] };

/** The slice of XMLHttpRequest that axios, jQuery and Angular rely on. */
class FakeXhr extends EventTarget {
  responseType = "";
  status = 200;
  responseURL = "";
  contentType = "application/json";
  payload: unknown = body;
  open(_method: string, url: string) {
    this.responseURL = url;
  }
  send(_body?: unknown) {
    queueMicrotask(() => this.dispatchEvent(new Event("load")));
  }
  getResponseHeader(name: string) {
    return name === "content-type" ? this.contentType : null;
  }
  get responseText() {
    if (this.responseType !== "" && this.responseType !== "text")
      throw new DOMException("InvalidStateError");
    return JSON.stringify(this.payload);
  }
  get response() {
    return this.responseType === "json" ? this.payload : this.responseText;
  }
}
(globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
instrumentXhr(INGEST);
instrumentXhr(INGEST); // idempotent

const request = (setup?: (xhr: FakeXhr) => void, url = "http://api.test/a/7") =>
  new Promise<FakeXhr>((resolve) => {
    const xhr = new XMLHttpRequest() as unknown as FakeXhr;
    xhr.open("get", url);
    setup?.(xhr);
    xhr.addEventListener("load", () => resolve(xhr));
    xhr.send();
  });

afterEach(() => {
  drainRequests();
  drainUsage();
});

describe("xhr adapter", () => {
  test("a body the app parses itself is tracked", async () => {
    const xhr = await request();
    const data = JSON.parse(xhr.responseText);
    void data.items[0].name;

    const [event] = drainRequests();
    expect(event).toMatchObject({
      source: "xhr",
      method: "GET",
      route: "api.test/a/:id",
      tracking: "tracked",
    });
    expect(requestIdOf(data)).toBe(event?.id);
    expect(drainUsage()[0]?.reads).toContain("items[].name");
    // One parse per response: the next one is an independent plain object.
    expect(requestIdOf(JSON.parse(xhr.responseText))).toBeUndefined();
  });

  test("a body nobody parses claims no field usage", async () => {
    await request();
    expect(drainRequests()[0]).toMatchObject({
      tracking: "untracked",
      leaves: [],
    });
  });

  test("responseType json hands out the tracked object", async () => {
    const xhr = await request((x) => {
      x.responseType = "json";
    });
    const data = xhr.response as typeof body;
    void data.total;
    expect(xhr.response).toBe(data);
    expect(drainRequests()[0]?.tracking).toBe("tracked");
    expect(drainUsage()[0]?.reads).toEqual(["total"]);
  });

  test("blob downloads, non-json and ingest traffic are left alone", async () => {
    const blob = await request((x) => {
      x.responseType = "blob";
    });
    expect(Object.hasOwn(blob, "response")).toBe(false);
    await request((x) => {
      x.contentType = "text/html";
    });
    await request(undefined, INGEST);
    expect(drainRequests()).toEqual([]);
  });

  test("a reviver keeps the native parse", async () => {
    const xhr = await request();
    const data = JSON.parse(xhr.responseText, (_k, v) => v);
    expect(requestIdOf(data)).toBeUndefined();
  });
});
