import { createRequire } from "node:module"
import path from "node:path"
import { cloudflare } from "@cloudflare/vite-plugin"
import vinext from "vinext"

const require = createRequire(import.meta.url)

const payloadBrowserInteropDependencies = [
  { importer: "payload", specifier: "ajv" },
  { importer: "payload", specifier: "bson-objectid" },
  { importer: "payload", specifier: "deepmerge" },
  { importer: "payload", specifier: "pluralize" },
  { importer: "@payloadcms/ui", specifier: "md5" },
  { importer: "@payloadcms/ui", specifier: "react/compiler-runtime" },
]

const payloadBrowserInteropAliases = Object.fromEntries(
  payloadBrowserInteropDependencies.map(({ importer, specifier }) => [
    specifier,
    require.resolve(specifier, {
      paths: [path.dirname(require.resolve(importer))],
    }),
  ]),
)

export default {
  optimizeDeps: {
    exclude: ["@payloadcms/next", "@payloadcms/ui"],
    include: ["ajv", "bson-objectid", "deepmerge", "md5", "pluralize", "react/compiler-runtime"],
  },
  plugins: [
    vinext(),
    ...(cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }) as []),
  ],
  resolve: {
    alias: {
      ...payloadBrowserInteropAliases,
    },
  },
}
