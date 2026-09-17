import { type QueryClient, replaceEqualDeep } from "@tanstack/query-core";
import { newId } from "./capture";
import { diagnostics } from "./diagnostics";
import { requestIdOf, setQueryKey, shareTracked, untracked } from "./tracker";

const clients = new WeakSet<QueryClient>();
const queryAliases = new Map<string, string>();

/** Page-scoped aliases preserve equality without exposing low-entropy query arguments. */
export function queryAlias(hash: string): string {
  const known = queryAliases.get(hash);
  if (known) return known;
  // Stop linking further distinct keys rather than changing existing identities.
  if (queryAliases.size >= 5000) return "";
  const alias = `q_${newId()}`;
  queryAliases.set(hash, alias);
  return alias;
}

/**
 * Keeps TanStack Query's structural sharing from counting as app reads and
 * links captured requests to their query hash.
 */
export function instrumentQueryClient(client: QueryClient) {
  if (clients.has(client)) return;
  clients.add(client);
  diagnostics.adapters.tanstack = true;
  // Structural sharing may return the previous reference, so the incoming
  // request is remembered here. setData runs it and dispatches "success"
  // synchronously, before any other query can overwrite this.
  let incoming: string | undefined;
  const defaults = client.getDefaultOptions();
  const sharing = defaults.queries?.structuralSharing ?? true;
  if (sharing !== false) {
    client.setDefaultOptions({
      ...defaults,
      queries: {
        ...defaults.queries,
        structuralSharing: (oldData: unknown, newData: unknown) => {
          incoming = requestIdOf(newData);
          const shared = untracked(() =>
            typeof sharing === "function"
              ? sharing(oldData, newData)
              : replaceEqualDeep(oldData, newData),
          );
          try {
            return incoming ? shareTracked(shared, incoming) : shared;
          } catch {
            return shared;
          }
        },
      },
    });
  }

  client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    const requestId = incoming ?? requestIdOf(event.query.state.data);
    incoming = undefined;
    if (requestId) setQueryKey(requestId, queryAlias(event.query.queryHash));
  });
}
