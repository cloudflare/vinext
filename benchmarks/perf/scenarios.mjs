export const performanceSetup = [
  { command: ["vp", "run", "build"] },
  { command: ["node", "benchmarks/generate-app.mjs"] },
  { command: ["npm", "install"], cwd: "benchmarks/nextjs" },
];

export const performanceScenarios = [
  {
    id: "dev-cold-start-root",
    suite: "Development",
    label: "Dev server cold start",
    description:
      "Time from launching a fresh dev-server process until the root route responds, with framework caches cleared before every round.",
    unit: "ms",
    lowerIsBetter: true,
    profile: true,
    implementations: [
      {
        id: "vinext",
        label: "vinext",
        command: ["node", "benchmarks/perf/cold-start.mjs", "vinext", "/"],
      },
      {
        id: "nextjs",
        label: "Next.js",
        command: ["node", "benchmarks/perf/cold-start.mjs", "nextjs", "/"],
      },
    ],
  },
  {
    id: "production-build",
    suite: "Build",
    label: "Production build time",
    description: "Time to complete a clean production build with previous output removed.",
    unit: "ms",
    lowerIsBetter: true,
    profile: false,
    implementations: [
      {
        id: "vinext",
        label: "vinext",
        command: ["node", "benchmarks/perf/build-time.mjs", "vinext"],
      },
      {
        id: "nextjs",
        label: "Next.js",
        command: ["node", "benchmarks/perf/build-time.mjs", "nextjs"],
      },
    ],
  },
  {
    id: "client-bundle-gzip",
    suite: "Build",
    label: "Client bundle size (gzip)",
    description:
      "Total gzip size of production client JavaScript and CSS emitted by the clean build.",
    unit: "bytes",
    lowerIsBetter: true,
    profile: false,
    implementations: [
      {
        id: "vinext",
        label: "vinext",
        command: ["node", "benchmarks/perf/bundle-size.mjs", "vinext"],
      },
      {
        id: "nextjs",
        label: "Next.js",
        command: ["node", "benchmarks/perf/bundle-size.mjs", "nextjs"],
      },
    ],
  },
];

export function benchmarkId(scenario, implementation) {
  return `${implementation.id}-${scenario.id}`;
}
