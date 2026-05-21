import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer, type ViteDevServer } from "vite";
import vinext from "../packages/vinext/src/index.js";

describe("Tailwind config compatibility", () => {
  const servers: ViteDevServer[] = [];
  const tmpDirs: string[] = [];

  function readPostcssPlugins(value: unknown): unknown[] {
    if (!value || typeof value !== "object") {
      throw new Error("Expected css.postcss to be an object");
    }
    const plugins = Reflect.get(value, "plugins");
    if (!Array.isArray(plugins)) {
      throw new Error("Expected css.postcss.plugins to be an array");
    }
    return plugins;
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      tmpDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
    );
  });

  async function createProject() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-tailwind-config-"));
    tmpDirs.push(root);
    await fs.mkdir(path.join(root, "app"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "@tailwindcss", "postcss"), {
      recursive: true,
    });
    await fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules", "vinext-deps"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { react: "*", "react-dom": "*" } }),
    );
    await fs.writeFile(
      path.join(root, "node_modules", "@tailwindcss", "postcss", "package.json"),
      JSON.stringify({ type: "module", name: "@tailwindcss/postcss", main: "index.js" }),
    );
    await fs.writeFile(
      path.join(root, "node_modules", "@tailwindcss", "postcss", "index.js"),
      `export default function tailwindPostcss() {
  return { postcssPlugin: "@tailwindcss/postcss", Once() {} };
}`,
    );
    await fs.mkdir(path.join(root, "node_modules", "mock-postcss-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(root, "node_modules", "mock-postcss-plugin", "package.json"),
      JSON.stringify({ type: "module", name: "mock-postcss-plugin", main: "index.js" }),
    );
    await fs.writeFile(
      path.join(root, "node_modules", "mock-postcss-plugin", "index.js"),
      `export default function mockPostcssPlugin() {
  return { postcssPlugin: "mock-postcss-plugin", Once() {} };
}`,
    );
    await fs.writeFile(
      path.join(root, "app", "layout.tsx"),
      `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
    );
    await fs.writeFile(
      path.join(root, "app", "page.tsx"),
      `export default function Page() { return <p>tailwind config test</p>; }`,
    );
    return root;
  }

  it("translates the known Tailwind Turbopack CSS loader to Vite PostCSS config", async () => {
    const root = await createProject();
    await fs.writeFile(
      path.join(root, "next.config.mjs"),
      `export default {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/webpack"],
      },
    },
  },
};`,
    );

    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
      server: { port: 0 },
    });
    servers.push(server);

    const postcss = server.config.css.postcss;
    const plugins = readPostcssPlugins(postcss);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toHaveProperty("postcssPlugin", "@tailwindcss/postcss");
  });

  it("does not append a second Tailwind plugin when Tailwind already runs through PostCSS", async () => {
    const root = await createProject();
    await fs.writeFile(
      path.join(root, "next.config.mjs"),
      `export default {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/webpack"],
      },
    },
  },
};`,
    );
    await fs.writeFile(
      path.join(root, "postcss.config.mjs"),
      `export default { plugins: ["@tailwindcss/postcss"] };`,
    );

    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
      server: { port: 0 },
    });
    servers.push(server);

    const plugins = readPostcssPlugins(server.config.css.postcss);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toHaveProperty("postcssPlugin", "@tailwindcss/postcss");
  });

  it("prepends translated Tailwind before existing PostCSS plugins", async () => {
    const root = await createProject();
    await fs.writeFile(
      path.join(root, "next.config.mjs"),
      `export default {
  turbopack: {
    rules: {
      "*.scss": {
        loaders: ["@tailwindcss/webpack"],
      },
    },
  },
};`,
    );
    await fs.writeFile(
      path.join(root, "postcss.config.mjs"),
      `export default { plugins: ["mock-postcss-plugin"] };`,
    );

    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
      server: { port: 0 },
    });
    servers.push(server);

    const plugins = readPostcssPlugins(server.config.css.postcss);
    expect(plugins.map((plugin) => Reflect.get(Object(plugin), "postcssPlugin"))).toEqual([
      "@tailwindcss/postcss",
      "mock-postcss-plugin",
    ]);
  });

  it("does not translate the Tailwind Turbopack loader when the Vite plugin is configured", async () => {
    const root = await createProject();
    await fs.writeFile(
      path.join(root, "next.config.mjs"),
      `export default {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/webpack"],
      },
    },
  },
};`,
    );

    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [{ name: "@tailwindcss/vite" }, vinext()],
      server: { port: 0 },
    });
    servers.push(server);

    expect(server.config.css.postcss).toBeUndefined();
  });

  it("preserves explicit Vite PostCSS string paths", async () => {
    const root = await createProject();
    await fs.writeFile(
      path.join(root, "next.config.mjs"),
      `export default {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/webpack"],
      },
    },
  },
};`,
    );
    await fs.writeFile(path.join(root, "custom-postcss.config.cjs"), "module.exports = {};");

    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      css: { postcss: "custom-postcss.config.cjs" },
      plugins: [vinext()],
      server: { port: 0 },
    });
    servers.push(server);

    expect(server.config.css.postcss).toBe("custom-postcss.config.cjs");
  });

  it("does not override opaque PostCSS configs when translating Tailwind Turbopack loaders", async () => {
    const root = await createProject();
    await fs.writeFile(
      path.join(root, "next.config.mjs"),
      `export default {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/webpack"],
      },
    },
  },
};`,
    );
    await fs.writeFile(
      path.join(root, ".postcssrc.yml"),
      `plugins:
  autoprefixer: {}
`,
    );

    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
      server: { port: 0 },
    });
    servers.push(server);

    expect(server.config.css.postcss).toBeUndefined();
  });
});
