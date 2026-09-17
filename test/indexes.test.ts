import { expect, test } from "bun:test";
import { drainUsage, track } from "../src/tracker";

const usageOf = (requestId: string) =>
  drainUsage().find((e) => e.requestId === requestId);

test("element reads report the highest index and the list length", () => {
  const data = track(
    { value: Array.from({ length: 50 }, (_, i) => ({ i })) },
    "idx",
  );
  for (const row of data.value.slice(0, 10)) void row.i;
  expect(usageOf("idx")?.indexes).toEqual([
    { path: "value[]", max: 9, length: 50 },
  ]);
  // Nothing new read: no indexes in the next drain.
  void data.value[3]?.i;
  expect(usageOf("idx")?.indexes).toBeUndefined();
  // Mapping the whole list reaches the last index.
  data.value.map((row) => row.i);
  expect(usageOf("idx")?.indexes).toEqual([
    { path: "value[]", max: 49, length: 50 },
  ]);
});
