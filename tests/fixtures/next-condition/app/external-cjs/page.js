import { named as exportsNamed } from "my-external-cjs-package/exports";
import { named as importsNamed } from "my-external-cjs-package/imports";
import Client from "./client";

export default async function Page() {
  const dynamicExports = await import("my-external-cjs-package/exports");
  return (
    <main>
      <p id="server">{[exportsNamed, importsNamed, dynamicExports.named].join(" | ")}</p>
      <Client />
    </main>
  );
}
