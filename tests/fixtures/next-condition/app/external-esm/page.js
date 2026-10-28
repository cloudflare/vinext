import { named as exportsNamed } from "my-external-esm-package/exports";
import { named as importsNamed } from "my-external-esm-package/imports";
import Client from "./client";

export default async function Page() {
  const dynamicExports = await import("my-external-esm-package/exports");
  return (
    <main>
      <p id="server">{[exportsNamed, importsNamed, dynamicExports.named].join(" | ")}</p>
      <Client />
    </main>
  );
}
