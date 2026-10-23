import { describe, expect, test } from "bun:test";
import { instrumentClone } from "../src/clone";
import { diagnostics } from "../src/diagnostics";
import { drainUsage, track } from "../src/tracker";

instrumentClone();

const cloneError = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as Error).name;
  }
};

describe("instrumentClone", () => {
  test("structuredClone copies tracked data instead of throwing", () => {
    const data = track({ rows: [{ id: 1, tags: ["a"] }] }, "clone-root");
    const before = diagnostics.unwrappedClones;
    expect(structuredClone(data)).toEqual({ rows: [{ id: 1, tags: ["a"] }] });
    expect(diagnostics.unwrappedClones).toBe(before + 1);
  });

  test("proxies inside app objects are unwrapped and shared references kept", () => {
    const data = track({ rows: [{ id: 1 }] }, "clone-nested");
    const row = data.rows[0];
    const copy = structuredClone({ a: row, b: row, list: data.rows });
    expect(copy.a).toEqual({ id: 1 });
    expect(copy.a).toBe(copy.b);
    expect(copy.list[0]).toBe(copy.a);
  });

  test("cycles survive", () => {
    const node: { id: number; self?: unknown } = { id: 1 };
    node.self = node;
    const copy = structuredClone(track(node, "clone-cycle"));
    expect(copy.self).toBe(copy);
  });

  test("a value that cannot be cloned for another reason still throws", () => {
    const data = track({ id: 1 }, "clone-fn");
    expect(cloneError(() => structuredClone({ data, run: () => 1 }))).toBe(
      "DataCloneError",
    );
  });

  test("cloned paths are reported untracked, not unused", () => {
    const data = track({ rows: [{ id: 1 }] }, "clone-gap");
    structuredClone(data.rows);
    const usage = drainUsage().find((e) => e.requestId === "clone-gap");
    expect(usage?.untracked).toContain("rows");
  });

  test("MessagePort.postMessage retries with the raw data", async () => {
    const { port1, port2 } = new MessageChannel();
    const received = new Promise((resolve) => {
      port2.onmessage = (event) => resolve(event.data);
    });
    port1.postMessage(track({ id: 7 }, "clone-port"));
    expect(await received).toEqual({ id: 7 });
    port1.close();
    port2.close();
  });
});
