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
  RocketLaunchIcon,
  SparkleIcon,
} from "@phosphor-icons/react/dist/ssr";

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

const CARD = "flex w-full flex-col gap-3 rounded-lg bg-kumo-base p-6 ring ring-kumo-hairline";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-kumo-canvas">
      <header className="w-full border-b border-kumo-hairline">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <RocketLaunchIcon size={20} className="text-kumo-default" />
            <span className="font-semibold tracking-tight text-kumo-default">vinext</span>
            <Badge variant="beta" className="ml-2">
              Experimental
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <LinkButton
              variant="ghost"
              size="sm"
              icon={<NewspaperIcon />}
              href="https://blog.cloudflare.com/vinext/"
              external
            >
              Announcement
            </LinkButton>
            <LinkButton
              variant="ghost"
              size="sm"
              icon={<GithubLogoIcon />}
              href="https://github.com/cloudflare/vinext"
              external
            >
              GitHub
            </LinkButton>
          </div>
        </div>
      </header>

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

      <footer className="mt-auto border-t border-kumo-hairline">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-6 py-6 sm:flex-row">
          <Text variant="secondary" size="sm">
            vinext is open source and experimental. Issues and PRs are welcome.
          </Text>
          <div className="flex items-center gap-4">
            <KumoLink
              href="https://github.com/cloudflare/vinext"
              variant="plain"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </KumoLink>
          </div>
        </div>
      </footer>
    </div>
  );
}
