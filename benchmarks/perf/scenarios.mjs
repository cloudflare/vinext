import scenarioManifest from "./scenarios.json" with { type: "json" };

export const performanceSetup = scenarioManifest.setup;
export const performanceScenarios = scenarioManifest.scenarios;

export function benchmarkId(scenario, implementation) {
  return `${implementation.id}-${scenario.id}`;
}
