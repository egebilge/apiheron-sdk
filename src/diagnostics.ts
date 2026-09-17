// Inlined by the bundler: only the version string reaches the output.
import { version } from "../package.json";

/** Local diagnostics contain counts only, never response values or ingest keys. */
const health = {
  initialized: false,
  sampled: true,
  adapters: { fetch: false, xhr: false, axios: false, tanstack: false },
  captured: 0,
  untracked: 0,
  truncated: 0,
  truncatedUsage: 0,
  bufferedRequests: 0,
  dropped: 0,
  sent: 0,
  retried: 0,
  failures: 0,
  /** Exceptions inside SDK code that were swallowed to protect the app. */
  errors: 0,
  queued: 0,
  pausedUntil: 0,
  lastStatus: null as number | null,
};

export const diagnostics = health;

/** A detached snapshot suitable for a setup health check or the browser console. */
export function getCaptureHealth() {
  return {
    ...health,
    queued: health.queued + health.bufferedRequests,
    adapters: { ...health.adapters },
  };
}

export const SDK_VERSION = version;
