# @apiheron/sdk

Browser capture for [Apiheron](https://apiheron.com): records which fields of
your API responses the app actually reads. ESM only, no runtime dependencies.

```sh
npm i @apiheron/sdk
```

`init()` patches `fetch` and `XMLHttpRequest`, so requests made through axios,
jQuery, Angular or plain `fetch` are captured automatically. Importing the
package changes nothing; on the server `init()` is a no-op.

Next.js, `instrumentation-client.ts`:

```ts
import { init } from "@apiheron/sdk";

init({
  key: process.env.NEXT_PUBLIC_APIHERON_KEY!,
  endpoint: "https://app.apiheron.com/api/ingest",
  release: process.env.NEXT_PUBLIC_COMMIT_SHA,
});
```

Vite, first lines of `main.ts`:

```ts
import { init } from "@apiheron/sdk";

init({
  key: import.meta.env.VITE_APIHERON_KEY,
  endpoint: "https://app.apiheron.com/api/ingest",
});
```

TanStack Query (optional, needs `@tanstack/query-core` 5 or later, which
`@tanstack/react-query` already installs):

```ts
import { instrumentQueryClient } from "@apiheron/sdk/tanstack";

instrumentQueryClient(queryClient); // before the first query
```

## Options

| Option            | Type       | Default  | Meaning                                                                  |
| ----------------- | ---------- | -------- | ------------------------------------------------------------------------ |
| `key`             | `string`   | required | Ingest key from Workspace → Projects, e.g. `ah_ingest_…`.                |
| `endpoint`        | `string`   | required | The collector's ingest URL.                                              |
| `flushIntervalMs` | `number`   | `2000`   | How often buffered events are sent.                                      |
| `ignore`          | `string[]` | `[]`     | URL substrings to skip, e.g. `["/health", "analytics."]`.                |
| `release`         | `string`   | none     | Build of the app, e.g. a commit SHA; links findings and source maps.     |
| `sampleRate`      | `number`   | `1`      | Share of page loads to record, 0 to 1. Decided once per page load.       |
| `captureRequests` | `boolean`  | `false`  | Also send each request's URL and body as sent, for "Copy as cURL".      |

## What leaves the page

- Field paths of JSON responses and which of them the app read, e.g.
  `items[].price`. Response values are never sent.
- Method, status, timing, response size, a hash of the request body, the code
  location that made the request, and the route. Id-like path segments (numbers, uuids,
  tokens, email addresses) and query values are hashed; other path segments and
  field names stay readable.
- TanStack query keys as random, page-scoped aliases; scenario names as typed.

- Only with `captureRequests: true` (script tag: `data-capture-requests`): the
  request URL and body as sent, so the dashboard can copy a runnable cURL.
  Query and body fields whose names look like credentials (`password`,
  `token`, `…_key`, …) are replaced with `***`; FormData, files and bodies
  over 8 KB are not sent. Headers are never read, so the cURL carries a
  `$TOKEN` placeholder.

Use `ignore` for URLs that should not be recorded at all.

## Browser capture

The script build exposes `window.apiheron`. With `data-badge`, the local panel
shows captured/untracked/incomplete request counts, delivery failures, dropped
or queued events, and installed adapters. Its scenario controls label requests
started during a workflow; repeating a name creates a new run ID.

```ts
const runId = window.apiheron.startScenario("checkout");
// Exercise the workflow, then:
const run = window.apiheron.endScenario();
const health = window.apiheron.getCaptureHealth();
```

The same three functions are exported from `@apiheron/sdk`. `fetch` and
`XMLHttpRequest` are patched when capture starts, so axios, jQuery and Angular
need no wiring: a body read as text is tracked when that exact text reaches
`JSON.parse` within a second, and stays untracked (no field-usage claim) when
nobody parses it. `instrumentAxios(instance)` is optional. Install the TanStack
adapter with `instrumentQueryClient(client)` before issuing queries. Adapter readiness means
the adapter was installed; captured requests and reads provide the evidence that
it is working. Per-query overrides of TanStack structural sharing should retain
the adapter's sharing function if field tracking is required.

Scenario names are transmitted: use workflow labels rather than customer names
or other sensitive data. The badge's **Copy telemetry preview** copies the last
ten local request events and health counters without an ingest key or response
values. Id-like path segments (numbers, uuids, tokens, email addresses) and query
values are hashed; other path segments and field names are still visible; inspect them when deciding
which URL substrings to exclude with `ignore`.

Query keys use random, page-scoped aliases; raw key arguments never leave the
page. Equality is preserved within that page, and cache-split detection compares
within a session. After 5,000 distinct keys, additional keys are not linked.

Requests include `tracking`, `truncated`, `sdkVersion`, and optional `scenario`
and `scenarioRunId`. Untracked or truncated captures are excluded from field
usage advice. The collector's existing schema accepts older SDK events too.

Delivery is bounded and best effort. Explicit 429 responses pause immediately
and retry at most three times. Unsent work is held within 1,000 events / 4 MB;
oldest events are dropped beyond that. Ambiguous network and server failures
are not replayed because usage operations are not idempotent. Inspect
`getCaptureHealth()` for counts, `lastStatus`, and `pausedUntil`; a failed event
is not silently reported as sent. Beacon acceptance means queued by the browser,
not confirmed by the collector.

## Source and issues

The source of this package lives at
[github.com/egebilge/apiheron-sdk](https://github.com/egebilge/apiheron-sdk);
report problems in its issue tracker. Releases are published from that
repository with npm trusted publishing, so every version carries a provenance
statement linking it to the commit it was built from. The repository is
exported from Apiheron's private monorepo: pull requests are welcome and are
applied upstream, then exported again.
