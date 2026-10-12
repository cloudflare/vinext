const records: Record<string, { owner: string; secret: string }> = {
  private: { owner: "victim", secret: "VICTIM_FORM_PRIVATE_RECORD" },
  public: { owner: "public", secret: "PUBLIC_FORM_RECORD" },
};

let executions = 0;

// FormData.get() reads the first of repeated fields, so the record depends on
// entry order, not just on the set of entries.
async function readScopedRecord(form: FormData) {
  "use cache";
  const scope = String(form.get("scope"));
  return { execution: ++executions, scope, record: records[scope] ?? null };
}

export async function POST(request: Request) {
  const form = await request.formData();
  if (
    form.get("scope") !== "public" &&
    request.headers.get("authorization") !== "Bearer fixture-victim-session"
  ) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  return Response.json(await readScopedRecord(form));
}
