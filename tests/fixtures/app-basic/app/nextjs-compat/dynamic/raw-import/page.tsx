// x-ref: https://github.com/vercel/next.js/issues/71840
// Port of Next.js test/e2e/app-dir/dynamic-import — a client component is
// loaded via a raw dynamic `import()` (not next/dynamic) inside an async
// server component, accessed through a named export.

import type { ElementType } from "react";

async function getImport(slug: string, exportName: string): Promise<ElementType> {
  const moduleExports = await import(`./${slug}`);
  return moduleExports[exportName];
}

export default async function Page() {
  const Button = await getImport("button", "Button");
  return <Button />;
}
