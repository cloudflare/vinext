import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { revalidateTemplateSeed } from "../actions";

async function RenderId() {
  await connection();
  return <span id="template-seed-render-id">{crypto.randomUUID()}</span>;
}

export default async function TemplateSeedPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const nextSection = section === "x" ? "y" : "x";

  return (
    <div>
      <h3 id="template-seed-section">Section {section}</h3>
      <Suspense fallback={null}>
        <RenderId />
      </Suspense>
      <Link href={`/nextjs-compat/back-forward-cache/template-seed/${nextSection}`}>
        To {nextSection}
      </Link>
      <form action={revalidateTemplateSeed}>
        <button type="submit" id="template-seed-revalidate">
          Revalidate
        </button>
      </form>
    </div>
  );
}

export function generateStaticParams() {
  return [{ section: "x" }, { section: "y" }];
}
