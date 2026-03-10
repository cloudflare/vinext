// Sends a failure notification email when the Next.js tip workflow fails.
// Expects EMAIL_API_TOKEN, GITHUB_TOKEN, GITHUB_SERVER_URL, GITHUB_REPOSITORY,
// and GITHUB_RUN_ID to be set in the environment.

async function getFailedJobs() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;

  if (!token || !repository || !runId) return [];

  const res = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) return [];

  const { jobs } = await res.json();
  return jobs.filter((j) => j.conclusion === "failure").map((j) => j.name);
}

async function sendEmail() {
  const token = process.env.EMAIL_API_TOKEN;
  if (!token) {
    console.error("EMAIL_API_TOKEN is not set");
    process.exit(1);
  }

  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY ?? "unknown/unknown";
  const runId = process.env.GITHUB_RUN_ID ?? "0";
  const runUrl = `${serverUrl}/${repository}/actions/runs/${runId}`;

  const failedJobs = await getFailedJobs();
  const failedList =
    failedJobs.length > 0
      ? `Failed jobs:\n${failedJobs.map((j) => `  - ${j}`).join("\n")}`
      : "Could not determine which jobs failed. Check the run URL.";

  // TODO: replace with your actual email API endpoint and payload format
  const res = await fetch("https://api.example.com/send-email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      subject: `vinext tip build failed -- ${repository}`,
      body: [
        "The scheduled Next.js tip (canary) build failed.",
        "",
        failedList,
        "",
        `Run: ${runUrl}`,
      ].join("\n"),
    }),
  });

  if (!res.ok) {
    console.error(`Email API returned ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  console.log("Failure notification sent.");
}

sendEmail().catch((err) => {
  console.error("Failed to send notification:", err.message);
  process.exit(1);
});
