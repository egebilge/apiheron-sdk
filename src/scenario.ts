export type Scenario = { scenario: string; scenarioRunId: string };
let active: (Scenario & { startedAt: number }) | undefined;

/** Use a descriptive workflow name; names are sent to the collector. */
export function startScenario(name: string): string {
  const scenario = name.trim();
  if (!scenario || scenario.length > 128)
    throw new RangeError("Scenario names must contain 1–128 characters.");
  const scenarioRunId =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  active = { scenario, scenarioRunId, startedAt: Date.now() };
  return scenarioRunId;
}

/** End the current workflow. Requests keep the scenario active when they started. */
export function endScenario() {
  const finished = active;
  active = undefined;
  return finished ? { ...finished, endedAt: Date.now() } : undefined;
}

export function currentScenario(): Scenario | undefined {
  return active
    ? { scenario: active.scenario, scenarioRunId: active.scenarioRunId }
    : undefined;
}
