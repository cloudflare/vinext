import { cookies } from "next/headers";
import { forbidden, notFound, redirect, unauthorized } from "next/navigation";

export function generateStaticParams() {
  return [
    { kind: "redirect" },
    { kind: "unauthorized" },
    { kind: "forbidden" },
    { kind: "not-found" },
  ];
}

// An auth guard: its cookies() read makes the render dynamic before the
// special error is thrown.
export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; kind: string }>;
}) {
  const { locale, kind } = await params;
  if (!(await cookies()).get("session")) {
    if (kind === "redirect") redirect(`/${locale}/blog/known`);
    if (kind === "unauthorized") unauthorized();
    if (kind === "forbidden") forbidden();
    notFound();
  }
  return <p id="auth-guard">{`Signed in (${locale})`}</p>;
}
