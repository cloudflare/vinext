/**
 * POST /api/compatibility/compare
 *
 * Downloads the `deploy-suite-report` artifacts for two GitHub Actions run ids
 * and returns assertion-level pass/fail changes. The baseline run id defaults
 * to the latest ingested main deploy-suite run from D1.
 */
import { inflateRawSync } from "node:zlib";
import { desc, eq } from "drizzle-orm";
import { getDb, getGitHubToken } from "../../../lib/db/client";
import { compatRuns } from "../../../lib/db/schema";

const OWNER = "cloudflare";
const REPO = "vinext";
const DEFAULT_KIND = "deploy";
const REPORT_ARTIFACT_NAME = "deploy-suite-report";
const REPORT_FILE_NAME = "deploy-suite-report.json";
const RUN_ID_RE = /^\d+$/;

type ReportTest = {
  suite: string;
  test: string;
};

type DeploySuiteReport = {
  timestamp?: string;
  vinextRef?: string;
  nextRef?: string;
  suiteFilter?: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  failed: ReportTest[];
  passed: ReportTest[];
};

type ComparedRun = {
  runId: string;
  htmlUrl: string;
  report: Pick<
    DeploySuiteReport,
    "timestamp" | "vinextRef" | "nextRef" | "suiteFilter" | "summary"
  >;
};

type Change = ReportTest & {
  before: "passed" | "failed" | "missing";
  after: "passed" | "failed" | "missing";
};

type ChangeGroups = {
  regressions: Change[];
  newFailures: Change[];
  fixes: Change[];
  noLongerFailing: Change[];
};

type CompareBody = {
  baselineRunId?: string;
  targetRunId?: string;
};

type GitHubArtifactsResponse = {
  artifacts?: Array<{
    name?: string;
    expired?: boolean;
    archive_download_url?: string;
  }>;
};

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: CompareBody;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as CompareBody) : {};
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const targetRunId = normalizeRunId(body.targetRunId);
  if (!targetRunId) {
    return Response.json({ error: "A comparison run id is required" }, { status: 400 });
  }

  let baselineRunId = normalizeRunId(body.baselineRunId);
  if (!baselineRunId) {
    try {
      baselineRunId = await loadLatestMainRunId();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return Response.json(
        { error: "Failed to load the latest main baseline run id", detail },
        { status: 500 },
      );
    }
  }

  if (!baselineRunId) {
    return Response.json({ error: "No baseline run id was provided or ingested" }, { status: 400 });
  }

  try {
    const token = getGitHubToken();
    if (!token) {
      return Response.json(
        {
          error:
            "GITHUB_TOKEN is not configured on the worker; deploy-suite artifact downloads require authentication.",
        },
        { status: 503 },
      );
    }
    const [baselineReport, targetReport] = await Promise.all([
      downloadDeploySuiteReport(baselineRunId, token),
      downloadDeploySuiteReport(targetRunId, token),
    ]);
    const changes = compareDeploySuiteReports(baselineReport, targetReport);

    return Response.json({
      baseline: toComparedRun(baselineRunId, baselineReport),
      target: toComparedRun(targetRunId, targetReport),
      delta: {
        total: targetReport.summary.total - baselineReport.summary.total,
        passed: targetReport.summary.passed - baselineReport.summary.passed,
        failed: targetReport.summary.failed - baselineReport.summary.failed,
        skipped: targetReport.summary.skipped - baselineReport.summary.skipped,
      },
      changes,
      totals: Object.fromEntries(
        Object.entries(changes).map(([key, value]) => [key, value.length]),
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof HttpError ? error.status : 500;
    console.error("[/api/compatibility/compare] comparison failed:", message);
    return Response.json({ error: message }, { status });
  }
}

async function loadLatestMainRunId(): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ runKey: compatRuns.runKey })
    .from(compatRuns)
    .where(eq(compatRuns.kind, DEFAULT_KIND))
    .orderBy(desc(compatRuns.createdAt), desc(compatRuns.id))
    .limit(1);
  return normalizeRunId(rows[0]?.runKey);
}

function normalizeRunId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return RUN_ID_RE.test(trimmed) ? trimmed : null;
}

function toComparedRun(runId: string, report: DeploySuiteReport): ComparedRun {
  return {
    runId,
    htmlUrl: `https://github.com/${OWNER}/${REPO}/actions/runs/${runId}`,
    report: {
      timestamp: report.timestamp,
      vinextRef: report.vinextRef,
      nextRef: report.nextRef,
      suiteFilter: report.suiteFilter,
      summary: report.summary,
    },
  };
}

async function downloadDeploySuiteReport(runId: string, token: string): Promise<DeploySuiteReport> {
  const artifactsUrl = `https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${runId}/artifacts?per_page=100`;
  const artifactsResponse = await fetch(artifactsUrl, { headers: githubHeaders() });
  if (!artifactsResponse.ok) {
    throw new HttpError(
      `Failed to list artifacts for run ${runId} (${artifactsResponse.status})`,
      artifactsResponse.status,
    );
  }

  const payload = (await artifactsResponse.json()) as GitHubArtifactsResponse;
  const artifact = payload.artifacts?.find((entry) => entry.name === REPORT_ARTIFACT_NAME);
  if (!artifact?.archive_download_url) {
    throw new HttpError(`Run ${runId} does not have a ${REPORT_ARTIFACT_NAME} artifact`, 404);
  }
  if (artifact.expired) {
    throw new HttpError(`The ${REPORT_ARTIFACT_NAME} artifact for run ${runId} has expired`, 410);
  }

  const archiveResponse = await fetch(artifact.archive_download_url, {
    headers: githubHeaders(token),
  });
  if (!archiveResponse.ok) {
    const hint =
      archiveResponse.status === 401 || archiveResponse.status === 403
        ? "; check that GITHUB_TOKEN can read Actions artifacts for cloudflare/vinext and is authorized for the Cloudflare organization"
        : "";
    throw new HttpError(
      `Failed to download ${REPORT_ARTIFACT_NAME} for run ${runId} (${archiveResponse.status})${hint}`,
      archiveResponse.status,
    );
  }

  const reportText = extractZipTextFile(
    new Uint8Array(await archiveResponse.arrayBuffer()),
    REPORT_FILE_NAME,
  );
  const report = JSON.parse(reportText) as unknown;
  if (!isDeploySuiteReport(report)) {
    throw new HttpError(`Run ${runId} has an invalid ${REPORT_FILE_NAME}`, 502);
  }
  return report;
}

function githubHeaders(token?: string): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "vinext-web-compatibility",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function compareDeploySuiteReports(
  baseline: DeploySuiteReport,
  target: DeploySuiteReport,
): ChangeGroups {
  const baselineIndex = indexReportTests(baseline);
  const targetIndex = indexReportTests(target);
  const allKeys = new Set([...baselineIndex.keys(), ...targetIndex.keys()]);
  const changes: ChangeGroups = {
    regressions: [],
    newFailures: [],
    fixes: [],
    noLongerFailing: [],
  };

  for (const key of allKeys) {
    const before = baselineIndex.get(key);
    const after = targetIndex.get(key);
    if (before?.status === after?.status) continue;

    const test = after?.test ?? before?.test;
    if (!test) continue;

    const change: Change = {
      suite: test.suite,
      test: test.test,
      before: before?.status ?? "missing",
      after: after?.status ?? "missing",
    };

    if (change.before === "passed" && change.after === "failed") {
      changes.regressions.push(change);
    } else if (change.before === "missing" && change.after === "failed") {
      changes.newFailures.push(change);
    } else if (change.before === "failed" && change.after === "passed") {
      changes.fixes.push(change);
    } else if (change.before === "failed" && change.after === "missing") {
      changes.noLongerFailing.push(change);
    }
  }

  for (const group of Object.values(changes)) {
    group.sort(compareChange);
  }
  return changes;
}

function indexReportTests(report: DeploySuiteReport): Map<
  string,
  {
    status: "passed" | "failed";
    test: ReportTest;
  }
> {
  const index = new Map<string, { status: "passed" | "failed"; test: ReportTest }>();
  for (const test of report.passed) index.set(testKey(test), { status: "passed", test });
  for (const test of report.failed) index.set(testKey(test), { status: "failed", test });
  return index;
}

function testKey(test: ReportTest): string {
  return `${test.suite}\0${test.test}`;
}

function compareChange(left: Change, right: Change): number {
  return left.suite.localeCompare(right.suite) || left.test.localeCompare(right.test);
}

function isDeploySuiteReport(value: unknown): value is DeploySuiteReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  if (!isSummary(report.summary)) return false;
  return (
    Array.isArray(report.failed) &&
    report.failed.every(isReportTest) &&
    Array.isArray(report.passed) &&
    report.passed.every(isReportTest)
  );
}

function isSummary(value: unknown): value is DeploySuiteReport["summary"] {
  if (!value || typeof value !== "object") return false;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary.total === "number" &&
    typeof summary.passed === "number" &&
    typeof summary.failed === "number" &&
    typeof summary.skipped === "number"
  );
}

function isReportTest(value: unknown): value is ReportTest {
  if (!value || typeof value !== "object") return false;
  const test = value as Record<string, unknown>;
  return typeof test.suite === "string" && typeof test.test === "string";
}

function extractZipTextFile(zip: Uint8Array, wantedFileName: string): string {
  const eocdOffset = findEndOfCentralDirectory(zip);
  const centralDirectoryOffset = readUInt32(zip, eocdOffset + 16);
  const totalEntries = readUInt16(zip, eocdOffset + 10);
  let cursor = centralDirectoryOffset;

  for (let entry = 0; entry < totalEntries; entry++) {
    if (readUInt32(zip, cursor) !== 0x02014b50) {
      throw new HttpError("Invalid artifact zip central directory", 502);
    }

    const compressionMethod = readUInt16(zip, cursor + 10);
    const compressedSize = readUInt32(zip, cursor + 20);
    const fileNameLength = readUInt16(zip, cursor + 28);
    const extraLength = readUInt16(zip, cursor + 30);
    const commentLength = readUInt16(zip, cursor + 32);
    const localHeaderOffset = readUInt32(zip, cursor + 42);
    const fileName = decodeAscii(zip.subarray(cursor + 46, cursor + 46 + fileNameLength));

    if (fileName === wantedFileName || fileName.endsWith(`/${wantedFileName}`)) {
      return readZipEntry(zip, localHeaderOffset, compressedSize, compressionMethod);
    }

    cursor += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new HttpError(`Artifact zip did not contain ${wantedFileName}`, 404);
}

function readZipEntry(
  zip: Uint8Array,
  localHeaderOffset: number,
  compressedSize: number,
  compressionMethod: number,
): string {
  if (readUInt32(zip, localHeaderOffset) !== 0x04034b50) {
    throw new HttpError("Invalid artifact zip local header", 502);
  }

  const fileNameLength = readUInt16(zip, localHeaderOffset + 26);
  const extraLength = readUInt16(zip, localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength;
  const data = zip.subarray(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) return new TextDecoder().decode(data);
  if (compressionMethod === 8) return inflateRawSync(data).toString("utf8");
  throw new HttpError(`Unsupported zip compression method ${compressionMethod}`, 502);
}

function findEndOfCentralDirectory(zip: Uint8Array): number {
  for (let offset = zip.length - 22; offset >= 0; offset--) {
    if (readUInt32(zip, offset) === 0x06054b50) return offset;
  }
  throw new HttpError("Invalid artifact zip: missing end of central directory", 502);
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function decodeAscii(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}
