"use server";

import { cookies } from "next/headers";

// Both throws carry details that must never reach the browser in production.
export async function throwStructuredAction(): Promise<void> {
  throw {
    code: "DB_CONNECTION_FAILED",
    connectionString: "postgres://admin:s3cret@10.0.0.5:5432/prod",
    stack: new Error("structured failure").stack,
  };
}

export async function throwErrorAction(): Promise<void> {
  throw new Error("connect postgres://admin:s3cret@10.0.0.5:5432/prod failed");
}

export async function throwFormAction(_formData: FormData): Promise<void> {
  (await cookies()).set("action-error-cookie", "set-before-throw");
  throw new Error("connect postgres://admin:s3cret@10.0.0.5:5432/prod failed");
}
