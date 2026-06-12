// Ported from Next.js: test/e2e/app-dir/dynamic-import/dynamic-import.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic-import/dynamic-import.test.ts
import type { ElementType } from "react";

async function getImport(slug: string, exportName: string): Promise<ElementType> {
  const moduleExports = await import(`./${slug}`);
  return moduleExports[exportName];
}

export default async function Page() {
  const Button = await getImport("button", "Button");
  return <Button />;
}
