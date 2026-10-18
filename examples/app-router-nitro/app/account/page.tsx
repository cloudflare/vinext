import { cookies } from "next/headers";
import type { Metadata } from "next";
import { s } from "../_styles.js";

export const metadata: Metadata = {
  title: "Account",
  description: "A revalidate page that reads cookies, so it renders per request",
};

// As in Next.js, reading cookies() makes this page dynamic even though it
// exports `revalidate`, so each visitor gets their own render.
export const revalidate = 60;

export default async function AccountPage() {
  const session = (await cookies()).get("session")?.value ?? "anonymous";

  return (
    <main style={s.page}>
      <h1 style={s.title}>Account</h1>
      <p data-testid="account-user" style={s.badge}>
        Signed in as: {session}
      </p>
    </main>
  );
}
