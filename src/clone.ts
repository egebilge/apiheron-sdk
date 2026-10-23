import { diagnostics } from "./diagnostics";
import { unwrapDeep } from "./tracker";

const PATCHED = Symbol.for("apiheron.clone");

/** Prototype methods that structured-clone their first argument. */
const CLONING_METHODS: [type: string, method: string][] = [
  ["Worker", "postMessage"],
  ["MessagePort", "postMessage"],
  ["BroadcastChannel", "postMessage"],
  ["History", "pushState"],
  ["History", "replaceState"],
  ["IDBObjectStore", "put"],
  ["IDBObjectStore", "add"],
];

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

const isCloneError = (error: unknown) =>
  (error as { name?: unknown } | null)?.name === "DataCloneError";

/**
 * A call that fails only because its first argument holds tracking proxies is
 * retried with the raw data. The first attempt throws before anything is sent
 * or stored, and a value that cannot be cloned for another reason still throws.
 */
function retryUnwrapped(original: AnyFunction): AnyFunction {
  return function (this: unknown, ...args: unknown[]) {
    try {
      return original.apply(this, args);
    } catch (error) {
      if (!isCloneError(error) || !args.length) throw error;
      diagnostics.unwrappedClones++;
      args[0] = unwrapDeep(args[0]);
      return original.apply(this, args);
    }
  };
}

/**
 * Keeps response data cloneable: `structuredClone`, `postMessage` to workers,
 * channels and ports, history state and IndexedDB writes. `window.postMessage`
 * to another window runs that window's method and is not covered.
 */
export function instrumentClone() {
  const scope = globalThis as unknown as Record<PropertyKey, unknown>;
  if (scope[PATCHED]) return;
  scope[PATCHED] = true;
  if (typeof scope.structuredClone === "function")
    scope.structuredClone = retryUnwrapped(
      scope.structuredClone as AnyFunction,
    );
  for (const [type, method] of CLONING_METHODS) {
    const proto = (scope[type] as { prototype?: Record<string, unknown> })
      ?.prototype;
    const original = proto?.[method];
    if (proto && typeof original === "function")
      proto[method] = retryUnwrapped(original as AnyFunction);
  }
}
