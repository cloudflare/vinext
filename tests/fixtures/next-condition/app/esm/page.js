import { named as exportsNamed } from "my-esm-package/exports";
import { named as importsNamed } from "my-esm-package/imports";
import Client from "./client";

export default async function Page() {
  const dynamicExports = await import("my-esm-package/exports");
  return (
    <main>
      <p id="server">{[exportsNamed, importsNamed, dynamicExports.named].join(" | ")}</p>
      <Client />
    </main>
  );
}
