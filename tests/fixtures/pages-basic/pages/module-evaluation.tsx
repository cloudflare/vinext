import Link from "next/link";

if (typeof window !== "undefined") {
  const testWindow = window as typeof window & { __VINEXT_PAGE_EVALUATIONS__?: number };
  testWindow.__VINEXT_PAGE_EVALUATIONS__ = (testWindow.__VINEXT_PAGE_EVALUATIONS__ ?? 0) + 1;
}

export default function ModuleEvaluation() {
  return (
    <>
      <h1>Module Evaluation</h1>
      <Link href="/about">About</Link>
    </>
  );
}
