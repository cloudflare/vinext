# TurboSync

Synchronized video playback rooms. Watch videos with friends online with real-time playback sync using Cloudflare Durable Objects.

## What It Does

TurboSync lets you create rooms where everyone watches videos together in perfect sync. Play, pause, seek, or change the volume — it happens instantly for everyone in the room. Create public rooms or protect them with passwords for private viewing sessions.

## Why It's Awesome

- **Zero setup** — Just open the site, create a room, and share the link
- **Real-time sync** — WebSocket-powered communication keeps everyone on the same timestamp
- **Cloudflare-powered** — Built on Durable Objects with SQLite for rock-solid state management
- **Next.js made portable** — Originally a Next.js app, now running on Cloudflare Workers thanks to vinext
- **Beautiful UI** — Dark/light mode, responsive design, modern interface

## Tech Stack

- Next.js (App Router) → deployed via [vinext](https://github.com/anomalyco/vinext)
- Cloudflare Workers + Durable Objects
- Tailwind CSS + shadcn/ui

## Live Demo

**https://turbosync.devshell.blog**

Or: `turbosync.alisanan9090.workers.dev`

## Local Development

```bash
cd turbosync
pnpm install
pnpm dev
```

Open http://localhost:5173
