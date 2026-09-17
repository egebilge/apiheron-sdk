import { expect, test } from "bun:test";
import { graphqlOperation } from "../src/capture";
import { drainUsage, track } from "../src/tracker";

const usageOf = (requestId: string) =>
  drainUsage().find((e) => e.requestId === requestId);

const user = () => ({
  id: 1,
  name: "a",
  password: "x",
  address: { city: "c", zip: "z" },
});

test("walking an object's keys is recorded as enumeration, not as reads", () => {
  const data = track({ user: user() }, "keys");
  Object.keys(data.user);
  for (const _ in data.user);
  const copy = { ...data.user };
  Object.entries(data.user);
  const usage = usageOf("keys");
  expect(usage?.reads).toEqual(["user"]);
  expect(usage?.enumerated).toEqual(["user"]);
  // The copy holds the same values, and nested objects stay tracked.
  expect(copy.password).toBe("x");
  void copy.address.city;
  expect(usageOf("keys")?.reads).toEqual(["user.address.city"]);
});

test("explicit reads still count next to an enumeration", () => {
  const data = track({ user: user() }, "explicit");
  for (const key of Object.keys(data.user)) void key;
  void data.user.name;
  expect(usageOf("explicit")?.reads).toContain("user.name");
});

test("hasOwn before a read does not hide the read", () => {
  const data = track({ user: user() }, "hasOwn");
  if (Object.hasOwn(data.user, "id")) void data.user.id;
  expect(usageOf("hasOwn")?.reads).toEqual(["user", "user.id"]);
});

test("JSON.stringify enumerates the whole subtree without reading its fields", () => {
  const raw = { rows: [user(), user()], meta: { total: 2 } };
  const data = track(raw, "stringify");
  expect(JSON.stringify(data)).toBe(JSON.stringify(raw));
  const usage = usageOf("stringify");
  expect(usage?.reads).toEqual(["rows[]"]);
  expect(usage?.enumerated).toEqual(["", "rows[]", "rows[].address", "meta"]);
});

test("enumeration is recorded once per path, however many rows", () => {
  const data = track(
    { rows: Array.from({ length: 1000 }, (_, id) => ({ id })) },
    "dedupe",
  );
  for (const row of data.rows) Object.keys(row);
  expect(usageOf("dedupe")?.enumerated).toEqual(["rows[]"]);
  for (const row of data.rows) Object.keys(row);
  expect(usageOf("dedupe")).toBeUndefined();
});

test("frozen subtrees are reported as untracked", () => {
  const data = track({ a: Object.freeze({ x: 1 }), b: { y: { z: 1 } } }, "f");
  expect(data.a.x).toBe(1);
  // immer freezes deep after the proxy exists.
  const { b } = data;
  Object.freeze(b.y);
  Object.freeze(b);
  expect(b.y.z).toBe(1);
  expect(usageOf("f")?.untracked).toEqual(["a", "b.y"]);
});

test("GraphQL operation name comes from the body, nothing else does", () => {
  const query =
    "fragment F on U { id }\n query GetUser($id: ID!) { user { ...F } }";
  expect(graphqlOperation(JSON.stringify({ query }))).toBe("GetUser");
  expect(
    graphqlOperation(JSON.stringify({ query, operationName: "Named" })),
  ).toBe("Named");
  expect(graphqlOperation({ query: "mutation Save { save }" })).toBe("Save");
  expect(graphqlOperation({ operationName: "Persisted" })).toBe("Persisted");
  expect(graphqlOperation({ query, operationName: "a b<script>" })).toBe(
    "GetUser",
  );
  expect(graphqlOperation({ operationName: "A".repeat(500) })).toHaveLength(64);
  for (const body of [
    null,
    undefined,
    "",
    '{"query":',
    '{"query":"{ me { id } }"}',
    '{"name":"x"}',
    new FormData(),
    {
      get query(): string {
        throw new Error("app getter");
      },
    },
  ])
    expect(graphqlOperation(body)).toBeNull();
});
