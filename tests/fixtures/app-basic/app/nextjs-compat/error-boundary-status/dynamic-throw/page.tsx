import { cookies } from "next/headers";

// A dynamic page that throws before the document's shell is sent. Next.js
// renders the error.tsx above it with a 500.
export default async function DynamicThrowPage() {
  await cookies();
  throw new Error("error-boundary-status page render failed");
}
