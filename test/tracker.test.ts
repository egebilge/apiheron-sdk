import { describe, expect, test } from "bun:test";
import {
  drainUsage,
  requestIdOf,
  track,
  untracked,
  unwrap,
} from "../src/tracker";

const usageOf = (requestId: string) =>
  drainUsage().find((e) => e.requestId === requestId);

describe("track", () => {
  test("never proxies built-ins the app attaches to response objects", () => {
    const data = track({ rows: [{ id: 1 }] }, "builtins") as {
      rows: { id: number }[];
      lookup?: Map<number, string>;
      when?: Date;
    };
    data.lookup = new Map([[1, "a"]]);
    data.when = new Date(0);
    expect(data.lookup.get(1)).toBe("a");
    expect(data.when.getTime()).toBe(0);
    expect(requestIdOf(data.lookup)).toBeUndefined();
  });

  test("objects the app builds with map are not reads of the response", () => {
    const data = track({ rows: [{ id: 1, name: "a" }] }, "derived");
    const chart = data.rows.map((row) => ({ id: row.id, fill: "red" }));
    void chart[0]?.fill;
    Reflect.get(data.rows, "missing");
    expect(usageOf("derived")?.reads).toEqual(["rows", "rows[]", "rows[].id"]);
  });

  test("records only the paths the app reads", () => {
    const data = track(
      { total: 3, items: [{ id: 1, name: "a", secret: "x" }] },
      "reads",
    );
    for (const item of data.items) void item.name;
    expect(usageOf("reads")?.reads).toEqual([
      "items",
      "items[]",
      "items[].name",
    ]);
  });

  test("keeps identity stable and reports each path once", () => {
    const data = track({ user: { name: "a" } }, "identity");
    expect(data.user).toBe(data.user);
    expect(requestIdOf(data.user)).toBe("identity");
    void data.user.name;
    void data.user.name;
    expect(usageOf("identity")?.reads).toEqual(["user", "user.name"]);
    void data.user.name;
    expect(usageOf("identity")).toBeUndefined();
  });

  test("untracked reads are ignored", () => {
    const data = track({ a: 1, b: 2 }, "paused");
    untracked(() => JSON.stringify(data));
    expect(usageOf("paused")).toBeUndefined();
    void data.a;
    expect(usageOf("paused")?.reads).toEqual(["a"]);
  });

  test("records array transforms with counts and chain depth", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: i,
      active: i < 10,
    }));
    const data = track({ rows }, "ops");
    const result = data.rows
      .filter((row) => row.active)
      .map((row) => ({ ...row, label: String(row.id) }))
      .toSorted((a, b) => b.id - a.id);
    expect(result).toHaveLength(10);
    expect(result[0]?.id).toBe(9);
    const ops = usageOf("ops")?.ops.map(({ ms, ...rest }) => rest);
    expect(ops).toEqual([
      { op: "filter", inCount: 300, outCount: 10, depth: 0 },
      { op: "map", inCount: 10, outCount: 10, depth: 1 },
      { op: "toSorted", inCount: 10, outCount: 10, depth: 2 },
    ]);
  });

  test("in-place sort does not extend the chain", () => {
    const data = track({ list: [3, 1, 2] }, "sort");
    const sorted = data.list.sort();
    expect([...sorted]).toEqual([1, 2, 3]);
    expect(sorted.map((n) => n * 2)).toEqual([2, 4, 6]);
    expect(usageOf("sort")?.ops.map((o) => [o.op, o.depth])).toEqual([
      ["sort", 0],
      ["map", 0],
    ]);
  });

  test("survives the target being frozen after wrapping", () => {
    const data = track({ user: { name: "a" }, rows: [{ id: 1 }] }, "frozen");
    const { rows } = data;
    Object.freeze(data);
    Object.freeze(rows);
    expect(data.user.name).toBe("a");
    expect(rows[0]?.id).toBe(1);
    expect(usageOf("frozen")?.reads).toEqual(["rows", "user", "rows[]"]);
  });

  test("array ops use the real this", () => {
    const data = track({ rows: [{ id: 1 }, { id: 2 }] }, "this");
    const { filter } = data.rows;
    expect(() => filter.call(undefined, Boolean)).toThrow(TypeError);
    expect(filter.call([{ id: 5 }, null], Boolean)).toEqual([{ id: 5 }]);
    const acc: number[] = [];
    const out = data.rows.reduce((a, row) => {
      a.push(row.id);
      return a;
    }, acc);
    expect(out).toBe(acc);
  });

  test("reading length is not a read of the items", () => {
    const data = track({ rows: [{ id: 1 }] }, "length");
    void data.rows.length;
    expect(usageOf("length")?.reads).toEqual(["rows"]);
  });

  test("unwrap returns the raw object for structuredClone", () => {
    const raw = { user: { name: "a" } };
    const data = track(raw, "unwrap");
    expect(unwrap(data)).toBe(raw);
    expect(unwrap(raw)).toBe(raw);
    expect(unwrap(1)).toBe(1);
    expect(structuredClone(unwrap(data))).toEqual(raw);
  });
});
