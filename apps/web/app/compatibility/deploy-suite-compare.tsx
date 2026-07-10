"use client";

import { useMemo, useState } from "react";

type Summary = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
};

type ComparedRun = {
  runId: string;
  htmlUrl: string;
  report: {
    timestamp?: string;
    vinextRef?: string;
    nextRef?: string;
    suiteFilter?: string;
    summary: Summary;
  };
};

type Change = {
  suite: string;
  test: string;
  before: "passed" | "failed" | "missing";
  after: "passed" | "failed" | "missing";
};

type ChangeGroups = {
  regressions: Change[];
  newFailures: Change[];
  fixes: Change[];
  noLongerFailing: Change[];
};

type CompareResult = {
  baseline: ComparedRun;
  target: ComparedRun;
  delta: Summary;
  changes: ChangeGroups;
};

const GROUPS: ReadonlyArray<{
  key: keyof ChangeGroups;
  title: string;
  empty: string;
}> = [
  { key: "regressions", title: "Regressions", empty: "No pass-to-fail changes." },
  { key: "newFailures", title: "New failures", empty: "No newly failing tests." },
  { key: "fixes", title: "Fixes", empty: "No fail-to-pass changes." },
  {
    key: "noLongerFailing",
    title: "No longer failing in report",
    empty: "No failing tests disappeared from the target report.",
  },
];

const inputClass =
  "h-10 w-full rounded-md border border-kumo-hairline bg-kumo-base px-3 font-mono text-sm text-kumo-default outline-none transition focus:border-kumo-primary focus:ring-2 focus:ring-kumo-primary/20";

const buttonClass =
  "inline-flex h-10 w-full items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 lg:w-auto";

const metricClass = "rounded-md bg-kumo-elevated p-4 ring ring-kumo-hairline";

export function DeploySuiteCompare({ defaultBaselineRunId }: { defaultBaselineRunId: string }) {
  const [baselineRunId, setBaselineRunId] = useState(defaultBaselineRunId);
  const [targetRunId, setTargetRunId] = useState("");
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const hasChanges = useMemo(() => {
    if (!result) return false;
    return Object.values(result.changes).some((group) => group.length > 0);
  }, [result]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = targetRunId.trim();
    if (!target) {
      setError("Enter a comparison run id.");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/compatibility/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baselineRunId: baselineRunId.trim() || undefined,
          targetRunId: target,
        }),
      });
      const payload = (await response.json()) as
        | CompareResult
        | { error?: string; detail?: string };
      if (!response.ok) {
        const message =
          "error" in payload && payload.error
            ? payload.detail
              ? `${payload.error}: ${payload.detail}`
              : payload.error
            : "Failed to compare runs.";
        throw new Error(message);
      }
      setResult(payload as CompareResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form className="rounded-md bg-kumo-elevated p-4 ring ring-kumo-hairline" onSubmit={onSubmit}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <label className="flex min-w-0 flex-col gap-2 text-sm text-kumo-subtle">
            <span className="font-medium text-kumo-default">Baseline run</span>
            <input
              className={inputClass}
              inputMode="numeric"
              pattern="[0-9]*"
              value={baselineRunId}
              placeholder="Latest main run"
              onChange={(event) => setBaselineRunId(event.target.value)}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm text-kumo-subtle">
            <span className="font-medium text-kumo-default">Comparison run</span>
            <input
              className={inputClass}
              inputMode="numeric"
              pattern="[0-9]*"
              value={targetRunId}
              placeholder="GitHub Actions run id"
              onChange={(event) => setTargetRunId(event.target.value)}
            />
          </label>
          <button type="submit" disabled={loading} className={buttonClass}>
            {loading ? "Comparing..." : "Compare runs"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-kumo-subtle">
          {defaultBaselineRunId ? (
            <span>
              Latest main run:{" "}
              <span className="font-mono text-kumo-default">{defaultBaselineRunId}</span>
            </span>
          ) : null}
          {baselineRunId !== defaultBaselineRunId && defaultBaselineRunId ? (
            <button
              type="button"
              className="font-medium text-kumo-primary hover:underline"
              onClick={() => setBaselineRunId(defaultBaselineRunId)}
            >
              Reset baseline
            </button>
          ) : null}
        </div>
      </form>

      {error ? (
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700 ring ring-red-200">
          <div className="font-medium">Comparison failed</div>
          <div className="mt-1 leading-relaxed">{error}</div>
        </div>
      ) : null}

      {result ? (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 text-sm md:grid-cols-2">
            <RunSummary label="Baseline" run={result.baseline} />
            <RunSummary label="Comparison" run={result.target} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Passed" value={result.delta.passed} />
            <Metric label="Failed" value={result.delta.failed} />
            <Metric label="Skipped" value={result.delta.skipped} />
            <Metric label="Total" value={result.delta.total} />
          </div>

          {!hasChanges ? (
            <div className="rounded-md bg-kumo-elevated p-4 text-sm text-kumo-subtle ring ring-kumo-hairline">
              No pass/fail changes found between these reports.
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {GROUPS.map((group) => (
                <ChangeGroup
                  key={group.key}
                  title={group.title}
                  empty={group.empty}
                  changes={result.changes[group.key]}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  const formatted = value > 0 ? `+${value}` : String(value);
  const tone = value > 0 ? "text-red-600" : value < 0 ? "text-green-600" : "text-kumo-default";
  return (
    <div className={metricClass}>
      <div className="text-xs font-medium text-kumo-subtle">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tracking-tight ${tone}`}>{formatted}</div>
    </div>
  );
}

function RunSummary({ label, run }: { label: string; run: ComparedRun }) {
  const summary = run.report.summary;
  return (
    <div className="rounded-md bg-kumo-elevated p-4 ring ring-kumo-hairline">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-kumo-default">{label}</span>
        <a
          className="shrink-0 font-mono text-xs text-kumo-primary hover:underline"
          href={run.htmlUrl}
          target="_blank"
          rel="noreferrer"
        >
          {run.runId}
        </a>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-kumo-subtle">
        <span>{summary.passed} passed</span>
        <span>{summary.failed} failed</span>
        <span>{summary.skipped} skipped</span>
      </div>
      <div className="mt-1 font-mono text-xs text-kumo-subtle">
        {run.report.vinextRef ?? "unknown vinext ref"} ·{" "}
        {run.report.nextRef ?? "unknown Next.js ref"}
      </div>
    </div>
  );
}

function ChangeGroup({
  title,
  empty,
  changes,
}: {
  title: string;
  empty: string;
  changes: Change[];
}) {
  return (
    <section className="rounded-md bg-kumo-elevated p-4 ring ring-kumo-hairline">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-medium text-kumo-default">{title}</h4>
        <span className="rounded-full bg-kumo-base px-2 py-0.5 text-xs text-kumo-subtle ring ring-kumo-hairline">
          {changes.length}
        </span>
      </div>
      {changes.length === 0 ? (
        <p className="text-sm text-kumo-subtle">{empty}</p>
      ) : (
        <ul className="max-h-96 space-y-3 overflow-auto pr-2">
          {changes.map((change) => (
            <li key={`${change.suite}\0${change.test}`} className="text-sm">
              <div className="font-mono text-xs text-kumo-subtle">{change.suite}</div>
              <div className="mt-1 text-kumo-default">{change.test}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
