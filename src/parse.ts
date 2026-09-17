/** `JSON.parse` before the SDK touched it. */
export const nativeParse = JSON.parse;

const PATCHED = Symbol.for("apiheron.parse");
const pending = new Map<string, () => unknown>();
/** The app parses a body right after receiving it; later parses are its own business. */
const WINDOW_MS = 1000;

/**
 * Axios, jQuery, Angular, ky and ofetch read the body as text and parse it
 * themselves. When that exact text reaches `JSON.parse`, `adopt` supplies the
 * result, so field reads are tracked without wiring each library. One parse
 * per response: a second parse of the same text gets an independent object.
 */
export function expectParse(text: string, adopt: () => unknown) {
  pending.set(text, adopt);
  setTimeout(() => {
    if (pending.get(text) === adopt) pending.delete(text);
  }, WINDOW_MS);
}

/**
 * Installed when capture starts, not on first use: `JSON.parse(await r.text())`
 * resolves `JSON.parse` before the text arrives.
 */
export function installParse() {
  const current = JSON.parse as typeof JSON.parse & { [PATCHED]?: true };
  if (current[PATCHED]) return;
  const patched = function parse(
    this: unknown,
    text: string,
    reviver?: Parameters<typeof JSON.parse>[1],
  ) {
    if (pending.size && reviver === undefined && typeof text === "string") {
      const adopt = pending.get(text);
      if (adopt) {
        pending.delete(text);
        try {
          return adopt();
        } catch {
          // Fall through to the native parse.
        }
      }
    }
    return current.call(this, text, reviver);
  };
  JSON.parse = Object.assign(patched, { [PATCHED]: true as const });
}
