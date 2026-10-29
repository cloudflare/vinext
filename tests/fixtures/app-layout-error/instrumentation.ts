type RequestErrorReport = { message: string; digest: string | undefined; path: string };

export async function onRequestError(error: unknown, request: { path: string }): Promise<void> {
  const reports = ((globalThis as { __vinextLayoutErrorReports?: RequestErrorReport[] })
    .__vinextLayoutErrorReports ??= []);
  reports.push({
    message: error instanceof Error ? error.message : String(error),
    digest: (error as { digest?: string }).digest,
    path: request.path,
  });
}
