// tsc cannot bundle declarations and TypeScript 7 has no JS API for the tools
// that can. Two rewrites make its per-file output valid for a consumer:
// relative specifiers get ".js" (required by node16/nodenext), and the wire
// types from core/schema, which are inferred from zod and used by internal
// modules only, become `any`, so consumers never need zod's types.
// ponytail: a schema type in the public API would turn `any` silently; switch
// to a declaration bundler once one runs on TypeScript 7.
import { rm } from "node:fs/promises";
import { Glob } from "bun";

const dist = `${import.meta.dir}/dist`;
await rm(`${dist}/core/schema.d.ts`, { force: true });
for (const name of new Glob("**/*.d.ts").scanSync(dist)) {
  const file = Bun.file(`${dist}/${name}`);
  const text = (await file.text())
    .replace(
      /^import type \{([^}]+)\} from "\.\/core\/schema";$/gm,
      (_, names: string) =>
        names
          .split(",")
          .map((n) => `type ${n.trim()} = any;`)
          .join("\n"),
    )
    .replace(/(from |import\()"(\.\.?\/[^"]+)"/g, '$1"$2.js"');
  await Bun.write(file, text);
}

// The published package has no dependencies: nothing may import zod.
for (const name of new Glob("**/*").scanSync(dist)) {
  if (/from "zod"|core\/schema/.test(await Bun.file(`${dist}/${name}`).text()))
    throw new Error(`dist/${name} still references zod or core/schema`);
}
