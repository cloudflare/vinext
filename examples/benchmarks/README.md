# Performance Benchmarks

A dashboard for viewing vinext performance benchmarks, built with the App Router on Cloudflare Workers.

Compares build times and metrics across Next.js 16 (Turbopack), vinext (Rollup), and vinext (Rolldown) on every merge to main.

Uses a D1 database for benchmark storage and Tailwind CSS for styling.

## Running Locally

1. Install dependencies:

```sh
pnpm install
```

2. Start the dev server:

```sh
pnpm dev
```

3. Build for production:

```sh
pnpm build
```

4. Preview the production build:

```sh
pnpm preview
```
