import type { Plugin } from "vite";

const SOURCE_FIXTURE_MARKER =
  "/tests/fixtures/cf-esm-externals/__test_packages__/fake-worker-context-lib/";
const INSTALLED_FIXTURE_MARKER = "/fake-worker-context-lib@file+tests+fixtures+cf-esm-externals+";

export function isWorkerEsmFixtureImporter(importer: string | undefined): boolean {
  if (!importer) return false;
  const normalized = importer.replaceAll("\\", "/");
  return (
    normalized.includes(SOURCE_FIXTURE_MARKER) || normalized.includes(INSTALLED_FIXTURE_MARKER)
  );
}

export function shouldExternalizeMissingFixtureImport(
  source: unknown,
  importer: string | undefined,
): boolean {
  return source === "fail" && isWorkerEsmFixtureImporter(importer);
}

export function externalizeWorkerFixtureMissingImport(): Plugin {
  return {
    name: "test:externalize-worker-fixture-missing-import",
    resolveDynamicImport(source, importer) {
      if (shouldExternalizeMissingFixtureImport(source, importer)) {
        return { id: source, external: true };
      }
    },
    resolveId: {
      filter: { id: /^fail$/ },
      handler(source, importer) {
        // This does not externalize the fixture package. It only lets the copied
        // unreachable missing import survive resolution so the Worker fixture
        // can retain the upstream package shapes. It therefore does not preserve
        // the upstream sentinel's package-externalization role.
        if (shouldExternalizeMissingFixtureImport(source, importer)) {
          return { id: source, external: true };
        }
      },
    },
  };
}
