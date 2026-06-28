import { Badge } from "@cloudflare/kumo/components/badge";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { Grid } from "@cloudflare/kumo/components/grid";
import { Link as KumoLink } from "@cloudflare/kumo/components/link";
import { Text } from "@cloudflare/kumo/components/text";
import {
  ArrowSquareOutIcon,
  ArrowUpRightIcon,
  CloudIcon,
  DatabaseIcon,
  FileCodeIcon,
  GaugeIcon,
  GithubLogoIcon,
  LightningIcon,
  NewspaperIcon,
  PackageIcon,
  PlugsIcon,
  SparkleIcon,
} from "@phosphor-icons/react/dist/ssr";
import typescript from "shiki/langs/typescript.mjs";
import githubDarkDefault from "shiki/themes/github-dark-default.mjs";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// ISR: 5-minute revalidate. The home page is fully static so the cached
// output is effectively reused indefinitely between deploys; the revalidate
// window just bounds how long any change takes to roll out to viewers after
// a redeploy.
export const revalidate = 300;

const STATS = [
  {
    value: "Up to 4×",
    label: "faster production builds",
    detail: "Measured against Next.js 16 with Turbopack on a 33-route App Router benchmark app.",
  },
  {
    value: "~50%",
    label: "smaller client bundles",
    detail:
      "168.9 KB → 72.9 KB gzipped on the same benchmark. Tree-shaking and a lighter client runtime do the work.",
  },
  {
    value: "94%",
    label: "of the Next.js 16 API surface",
    detail:
      "App Router, Pages Router, RSC, server actions, ISR, middleware, route handlers. Coverage and gaps tracked openly.",
  },
] as const;

const PILLARS = [
  {
    icon: FileCodeIcon,
    title: "Drop-in Next.js",
    description:
      "Keep your existing app/, pages/, and next.config.js. The full Next.js 16 API surface is shimmed — App Router, Pages Router, RSC, server actions, ISR, middleware, and the next/* module imports you already use.",
  },
  {
    icon: LightningIcon,
    title: "Powered by Vite",
    description:
      "Fast HMR, native ESM, and the Vite plugin ecosystem. Built on @vitejs/plugin-rsc for React Server Components, and ready for Rolldown — the Rust-based bundler shipping in Vite 8.",
  },
  {
    icon: PlugsIcon,
    title: "Deploy anywhere",
    description:
      "Cloudflare Workers is the first deployment target, with one-command deploys via vinext deploy. Vercel, Netlify, AWS, Deno Deploy, and more, work through Nitro, and standalone Node bundles are emitted on demand.",
  },
] as const;

type PlatformFeature = {
  icon: typeof PackageIcon;
  title: string;
  description: string;
  badge?: string;
};

const PLATFORM_FEATURES: readonly PlatformFeature[] = [
  {
    icon: PackageIcon,
    title: "Platform bindings in your app code",
    description:
      "Import env from cloudflare:workers directly inside server components, route handlers, and server actions. Bindings work in dev and production with no proxy layer.",
  },
  {
    icon: DatabaseIcon,
    title: "ISR out of the box",
    description:
      "Stale-while-revalidate with background regeneration, matching the Next.js 16 CacheHandler interface. A KV-backed handler ships by default; R2 or your own backend can drop in.",
  },
  {
    icon: SparkleIcon,
    title: "Traffic-aware Pre-Rendering",
    description:
      "Pre-render only the pages real traffic hits, using zone analytics at deploy time. Popular pages get SSG-level latency without building tens of thousands of routes ahead of time.",
    badge: "Experimental",
  },
  {
    icon: GaugeIcon,
    title: "Image optimization",
    description:
      "Local images route through a runtime resize/transcode endpoint that integrates with the Cloudflare Images binding. Remote images use @unpic/react with auto-detection for 28 CDNs.",
  },
];

const EXAMPLES = [
  {
    name: "App Router Playground",
    description:
      "Vercel's official Next.js App Router Playground, running on vinext. Covers the breadth of App Router features — server components, parallel routes, streaming, error boundaries, metadata.",
    href: "https://app-router-playground.vinext.workers.dev",
  },
  {
    name: "Hacker News",
    description:
      "RSC-first Hacker News clone with streaming, nested layouts, and server actions. A good look at what an idiomatic vinext app feels like end to end.",
    href: "https://hackernews.vinext.workers.dev",
  },
] as const;

const VITE_CONFIG_EXAMPLES = [
  {
    title: "Start with vinext",
    description: "The smallest config for running a Next.js app through Vite.",
    code: `import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext()],
});`,
  },
  {
    title: "Deploy to Cloudflare Workers",
    description:
      "Add the Cloudflare Vite plugin, Workers KV caching, and Cloudflare Images optimization.",
    code: `import { cloudflare } from "@cloudflare/vite-plugin";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext({
      cache: {
        data: kvDataAdapter(),
      },
      images: {
        optimizer: imagesOptimizer(),
      },
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});`,
  },
  {
    title: "Or deploy with Nitro",
    description: "Use Nitro when you want adapters for Node, Vercel, Netlify, AWS, and more.",
    code: `import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext(), nitro()],
});`,
  },
] as const;

const CARD = "flex w-full flex-col gap-3 rounded-lg bg-kumo-base p-6 ring ring-kumo-hairline";

let highlighterPromise: ReturnType<typeof createHighlighterCore> | undefined;

function getHighlighter() {
  return (highlighterPromise ??= createHighlighterCore({
    langs: [typescript],
    themes: [githubDarkDefault],
    engine: createJavaScriptRegexEngine(),
  }));
}

async function CodeExample({ code }: { code: string }) {
  const highlightedCode = (await getHighlighter()).codeToHtml(code, {
    lang: "typescript",
    theme: "github-dark-default",
  });

  return (
    <div
      className="vinext-code-block overflow-hidden rounded-b-lg"
      dangerouslySetInnerHTML={{ __html: highlightedCode }}
    />
  );
}

export default function Home() {
  return (
    <>
      <section className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pb-20 pt-24 text-center">
        <Badge variant="outline" className="mb-6">
          The Next.js API surface, re-implemented on Vite
        </Badge>
        <h1 className="max-w-3xl text-5xl font-semibold leading-[1.05] tracking-tight text-kumo-default sm:text-6xl">
          Run your Next.js app on Vite. Deploy anywhere.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-kumo-subtle">
          Vinext is a Vite plugin that re-implements the Next.js API from scratch. Keep your{" "}
          <code className="font-mono text-kumo-default">app/</code>,{" "}
          <code className="font-mono text-kumo-default">pages/</code>, and{" "}
          <code className="font-mono text-kumo-default">next.config.js</code> as they are. Get a
          faster dev loop, smaller bundles, and a clean path to deploy on any host.
        </p>

        <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
          <LinkButton
            variant="primary"
            size="lg"
            icon={<GithubLogoIcon />}
            href="https://github.com/cloudflare/vinext"
            external
          >
            Get vinext on GitHub
          </LinkButton>
          <LinkButton
            variant="secondary"
            size="lg"
            icon={<NewspaperIcon />}
            href="https://blog.cloudflare.com/vinext/"
            external
          >
            Read the announcement
          </LinkButton>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-24">
        <Grid variant="1-3up" gap="base">
          {STATS.map(({ value, label, detail }) => (
            <div key={label} className={CARD}>
              <div className="text-5xl font-semibold tracking-tight text-kumo-default">{value}</div>
              <div className="text-base font-medium text-kumo-default">{label}</div>
              <p className="text-sm leading-relaxed text-kumo-subtle">{detail}</p>
            </div>
          ))}
        </Grid>
        <p className="mt-4 text-center text-sm text-kumo-subtle">
          Benchmarks are directional, not definitive. See the launch numbers and methodology in the{" "}
          <KumoLink
            href="https://blog.cloudflare.com/vinext/"
            variant="inline"
            target="_blank"
            rel="noopener noreferrer"
          >
            announcement
          </KumoLink>
          .
        </p>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-24">
        <div className="mb-10 flex flex-col items-center text-center">
          <Text variant="heading2" as="h2">
            The same framework, on a different foundation
          </Text>
          <p className="mt-3 max-w-2xl text-kumo-subtle">
            Vinext re-implements Next.js as a Vite plugin instead of wrapping its build output. That
            single decision unlocks a faster toolchain and a much wider set of deployment targets.
          </p>
        </div>

        <Grid variant="1-3up" gap="base">
          {PILLARS.map(({ icon: Icon, title, description }) => (
            <div key={title} className={CARD}>
              <Icon size={22} className="text-kumo-default" />
              <Text variant="heading3" as="h3">
                {title}
              </Text>
              <p className="text-sm leading-relaxed text-kumo-subtle">{description}</p>
            </div>
          ))}
        </Grid>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-24">
        <div className="mb-10 flex flex-col items-center text-center">
          <Text variant="heading2" as="h2">
            Production features, ready to go
          </Text>
          <p className="mt-3 max-w-2xl text-kumo-subtle">
            Caching, bindings, image optimization, and pre-rendering all work out of the box on
            Cloudflare Workers, with sensible defaults you can swap out when you need to.
          </p>
        </div>

        <Grid variant="2up" gap="base">
          {PLATFORM_FEATURES.map(({ icon: Icon, title, description, badge }) => (
            <div key={title} className={CARD}>
              <div className="flex items-center gap-2">
                <Icon size={20} className="text-kumo-default" />
                <Text variant="heading3" as="h3">
                  {title}
                </Text>
                {badge ? (
                  <Badge variant="beta" className="ml-auto">
                    {badge}
                  </Badge>
                ) : null}
              </div>
              <p className="text-sm leading-relaxed text-kumo-subtle">{description}</p>
            </div>
          ))}
        </Grid>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-24">
        <div className="mb-10 flex flex-col items-center text-center">
          <Text variant="heading2" as="h2">
            See it running
          </Text>
          <p className="mt-3 max-w-2xl text-kumo-subtle">
            Real Next.js apps, rebuilt on every push to main and deployed to Cloudflare Workers.
            Source is on{" "}
            <KumoLink
              href="https://github.com/cloudflare/vinext/tree/main/examples"
              variant="inline"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </KumoLink>
            .
          </p>
        </div>

        <Grid variant="2up" gap="base">
          {EXAMPLES.map(({ name, description, href }) => (
            <a
              key={name}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={`${CARD} group transition-colors hover:bg-kumo-elevated`}
            >
              <div className="flex items-center justify-between">
                <Text variant="heading3" as="h3">
                  {name}
                </Text>
                <ArrowSquareOutIcon
                  size={18}
                  className="text-kumo-subtle transition-colors group-hover:text-kumo-default"
                />
              </div>
              <p className="text-sm leading-relaxed text-kumo-subtle">{description}</p>
            </a>
          ))}
        </Grid>
      </section>

      <section className="mx-auto w-full max-w-4xl px-6 pb-24">
        <div className="flex flex-col items-center gap-6 rounded-2xl bg-kumo-base p-10 text-center ring-1 ring-kumo-hairline">
          <Text variant="heading2" as="h2">
            Migrate in one command
          </Text>
          <p className="max-w-xl text-kumo-subtle">
            <code className="font-mono text-kumo-default">npx vinext init</code> scans your project
            for compatibility issues, installs the right dependencies, generates a Vite config, and
            adds vinext scripts alongside your existing Next.js setup. It&apos;s non-destructive —{" "}
            <code className="font-mono text-kumo-default">next dev</code> keeps working.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <LinkButton
              variant="primary"
              icon={<CloudIcon />}
              href="https://github.com/cloudflare/vinext#quick-start"
              external
            >
              Read the quick start
            </LinkButton>
            <LinkButton
              variant="outline"
              icon={<ArrowUpRightIcon />}
              href="https://github.com/cloudflare/vinext#migrating-an-existing-nextjs-project"
              external
            >
              Migration guide
            </LinkButton>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-24">
        <div className="mb-10 max-w-2xl">
          <Badge variant="outline" className="mb-4">
            vite.config.ts
          </Badge>
          <Text variant="heading2" as="h2">
            Configure vinext in Vite
          </Text>
          <p className="mt-3 text-kumo-subtle">
            Start with the vinext plugin, then add the adapter for your deployment target. Your
            routes, components, and Next.js configuration stay exactly where they are.
          </p>
        </div>

        <div className="overflow-hidden rounded-2xl bg-kumo-base ring-1 ring-kumo-hairline">
          {VITE_CONFIG_EXAMPLES.map(({ title, description, code }, index) => (
            <article
              key={title}
              className="grid min-w-0 border-b border-kumo-hairline last:border-b-0 md:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]"
            >
              <div className="flex gap-4 p-6 md:p-8">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-kumo-elevated font-mono text-xs font-medium text-kumo-subtle ring-1 ring-kumo-hairline">
                  {String(index + 1).padStart(2, "0")}
                </div>
                <div className="min-w-0 pt-0.5">
                  <Text variant="heading3" as="h3">
                    {title}
                  </Text>
                  <p className="mt-2 text-sm leading-relaxed text-kumo-subtle">{description}</p>
                </div>
              </div>

              <div className="min-w-0 border-t border-kumo-hairline bg-[#0d1117] md:border-l md:border-t-0">
                <div className="flex items-center gap-3 border-b border-white/10 px-5 py-3">
                  <div className="flex gap-1.5" aria-hidden="true">
                    <span className="size-2.5 rounded-full bg-[#ff5f57]" />
                    <span className="size-2.5 rounded-full bg-[#febc2e]" />
                    <span className="size-2.5 rounded-full bg-[#28c840]" />
                  </div>
                  <span className="font-mono text-xs text-[#8b949e]">vite.config.ts</span>
                </div>
                <CodeExample code={code} />
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
