import { revalidatePath } from "next/cache";

// Test-only reset with fixed paths: each request-order case starts cold.
export function GET() {
  revalidatePath("/tenants/a/catalog");
  revalidatePath("/tenants/b/catalog");
  return Response.json({ reset: true });
}
