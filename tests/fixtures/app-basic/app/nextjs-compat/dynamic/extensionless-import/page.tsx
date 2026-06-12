// Ported from Next.js: test/e2e/app-dir/dynamic-import/dynamic-import.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic-import/dynamic-import.test.ts
import type { ElementType } from "react";

async function getImport<T>(slug: string, exportName: string): Promise<T> {
  const moduleExports = await import(`./${slug}`);
  return moduleExports[exportName];
}

async function getData(slug: string): Promise<{ message: string }> {
  const moduleExports = await import(`./${slug}`);
  return moduleExports.default;
}

async function getPrefixedImport(slug: string): Promise<string> {
  const moduleExports = await import(`./prefixed-${slug}`);
  return moduleExports.prefixedImport;
}

export default async function Page() {
  const Button = await getImport<ElementType>("button", "Button");
  const resolverPriority = await getImport<string>("resolver-priority", "resolverPriority");
  const data = await getData("data");
  const prefixedImport = await getPrefixedImport("module");
  return (
    <>
      <Button />
      <p>{resolverPriority}</p>
      <p>{data.message}</p>
      <p>{prefixedImport}</p>
    </>
  );
}
