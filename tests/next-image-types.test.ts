import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vite-plus/test";

// Next.js: https://github.com/vercel/next.js/pull/98597
// Editors strike these props through from TypeScript's deprecation suggestions,
// which only fire when the consumer-facing declarations keep ImageProps' JSDoc.
const DEPRECATED_PROPS = [
  "layout",
  "lazyBoundary",
  "lazyRoot",
  "objectFit",
  "objectPosition",
  "onLoadingComplete",
  "priority",
];

const IMAGE_PROPS = `src="/hero.png" alt="Hero" width={640} height={480} preload priority onLoadingComplete={() => {}} layout="fill" objectFit="cover" objectPosition="center" lazyBoundary="200px" lazyRoot="root"`;

async function linkPackage(root: string, packageName: string, target: string): Promise<void> {
  const linkPath = path.join(root, "node_modules", packageName);
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

describe("next/image consumer types", () => {
  it("reports Image's deprecated props as deprecated through vinext/types", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-image-types-"));
    const api = new API({ cwd: root });
    try {
      await linkPackage(
        root,
        "vinext",
        fileURLToPath(new URL("../packages/vinext", import.meta.url)),
      );
      await linkPackage(
        root,
        "@vinext/types",
        fileURLToPath(new URL("../packages/types", import.meta.url)),
      );
      for (const packageName of ["react", "@types/react"]) {
        await linkPackage(
          root,
          packageName,
          path.dirname(fileURLToPath(import.meta.resolve(`${packageName}/package.json`))),
        );
      }
      // Mirrors the tsconfig.json that create-vinext-app generates.
      await writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            module: "esnext",
            moduleResolution: "bundler",
            isolatedModules: true,
            jsx: "preserve",
            types: ["vinext/types"],
          },
          include: ["**/*.tsx"],
        }),
      );
      const file = path.join(root, "page.tsx");
      const source = `import Image, { type ImageProps } from "next/image";
import ShimImage from "vinext/shims/image";

export default function Page() {
  return (
    <>
      <Image ${IMAGE_PROPS} />
      <ShimImage ${IMAGE_PROPS} />
    </>
  );
}

// Upstream's interface version of ImageProps breaks both of these.
export function styleOf(props: ImageProps) {
  return (props as Record<string, unknown>).style;
}
export const record: Record<string, unknown> = {} as ImageProps;
`;
      await writeFile(file, source);

      const snapshot = api.updateSnapshot({ openFiles: [file] });
      try {
        const project = snapshot.getDefaultProjectForFile(file);
        if (!project) throw new Error("Expected a TypeScript project for the consumer page");
        expect(project.program.getSemanticDiagnostics(file).map((d) => d.text)).toEqual([]);

        const deprecated = project.program
          .getSuggestionDiagnostics(file)
          .filter((diagnostic) => diagnostic.reportsDeprecated)
          .map((diagnostic) => ({
            line: source.slice(0, diagnostic.pos).split("\n").length,
            prop: source.slice(diagnostic.pos, diagnostic.end),
          }));
        const propsOnLine = (line: number) =>
          deprecated
            .filter((entry) => entry.line === line)
            .map((entry) => entry.prop)
            .sort();

        // `preload` is the non-deprecated control on each line.
        expect(propsOnLine(7), "next/image").toEqual(DEPRECATED_PROPS);
        expect(propsOnLine(8), "vinext/shims/image").toEqual(DEPRECATED_PROPS);
        expect(deprecated).toHaveLength(DEPRECATED_PROPS.length * 2);
      } finally {
        snapshot.dispose();
      }
    } finally {
      api.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
