import { defineConfig } from "drizzle-kit";

// Schema-only config: drizzle-kit generates SQL migrations that cf
// applies to D1 (via `cf d1 migrations apply ...`). We don't connect
// directly to D1 from drizzle-kit, so no credentials are needed here.
export default defineConfig({
  dialect: "sqlite",
  schema: "./app/lib/db/schema.ts",
  out: "./migrations",
});
