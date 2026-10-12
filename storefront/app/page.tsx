const links = [
  {
    href: "https://github.com/cloudflare/vinext",
    label: "vinext",
  },
  {
    href: "https://developers.cloudflare.com/workers/",
    label: "Workers",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <section className="mx-auto flex max-w-4xl flex-col gap-8">
        <div className="flex flex-col gap-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-orange-600">
            vinext + Cloudflare Workers
          </p>
          <h1 className="max-w-2xl text-4xl font-semibold leading-tight sm:text-5xl">
            Build Next.js-style apps with Vite and deploy them to the edge.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-slate-700">
            This App Router project is wired for vinext, Tailwind CSS, and Cloudflare Workers.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="font-semibold">Develop</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">Run the vinext dev server locally.</p>
            <code className="mt-4 block rounded bg-slate-100 px-3 py-2 text-sm">pnpm run dev</code>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="font-semibold">Build</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">Create Worker-ready production output.</p>
            <code className="mt-4 block rounded bg-slate-100 px-3 py-2 text-sm">pnpm run build</code>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="font-semibold">Deploy</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">Ship the generated Worker with cf.</p>
            <code className="mt-4 block rounded bg-slate-100 px-3 py-2 text-sm">pnpm run deploy</code>
          </div>
        </div>

        <nav className="flex flex-wrap gap-3">
          {links.map((link) => (
            <a
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-100"
              href={link.href}
              key={link.href}
              rel="noreferrer"
              target="_blank"
            >
              {link.label}
            </a>
          ))}
          <a
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-100"
            href="/api/hello"
          >
            API route
          </a>
        </nav>
      </section>
    </main>
  );
}
