#!/usr/bin/env node
/**
 * Generate the shared 33-route benchmark app.
 * Shared between the Next.js and vinext benchmark projects.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

// Seeded PRNG (mulberry32) for deterministic source generation across runs.
function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(42);

const APP = join(dirname(new URL(import.meta.url).pathname), "app");

// Clean and recreate
rmSync(APP, { recursive: true, force: true });

function write(rel, content) {
  const p = join(APP, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content.trimStart() + "\n");
}

// ─── Root layout ───────────────────────────────────────────────────────────────
write(
  "layout.tsx",
  `
// Force all pages to be dynamically rendered (no static pre-rendering).
// Without this, Next.js detects most pages as static and pre-renders them at
// build time — work that vinext doesn't do. This benchmark is designed to
// compare build/compilation speed, not static generation, so we opt out of
// pre-rendering to keep the comparison apples-to-apples.
export const dynamic = "force-dynamic";

export const metadata = {
  title: { default: "Benchmark App", template: "%s | Benchmark" },
  description: "A realistic benchmark app for comparing Next.js and vinext",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav style={{ padding: "1rem", borderBottom: "1px solid #eee", display: "flex", gap: "1rem" }}>
          <a href="/">Home</a>
          <a href="/products">Products</a>
          <a href="/blog">Blog</a>
          <a href="/dashboard">Dashboard</a>
          <a href="/about">About</a>
          <a href="/docs">Docs</a>
          <a href="/settings">Settings</a>
        </nav>
        <main style={{ padding: "1rem" }}>{children}</main>
      </body>
    </html>
  );
}
`,
);

// ─── Home page ─────────────────────────────────────────────────────────────────
write(
  "page.tsx",
  `
export default function Home() {
  const now = new Date().toISOString();
  return (
    <div>
      <h1>Benchmark App</h1>
      <p>Server-rendered at {now}</p>
      <p>This is a realistic benchmark app with 33 routes, nested layouts, dynamic routes, and client components.</p>
    </div>
  );
}
`,
);

// ─── Shared client components ──────────────────────────────────────────────────
write(
  "_components/counter.tsx",
  `
"use client";
import { useState } from "react";

export function Counter({ label = "Count" }: { label?: string }) {
  const [count, setCount] = useState(0);
  return (
    <div style={{ padding: "0.5rem", border: "1px solid #ddd", borderRadius: "4px", display: "inline-block" }}>
      <span>{label}: {count}</span>
      <button onClick={() => setCount(c => c + 1)} style={{ marginLeft: "0.5rem" }}>+</button>
    </div>
  );
}
`,
);

write(
  "_components/timer.tsx",
  `
"use client";
import { useState, useEffect } from "react";

export function Timer() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <span>Uptime: {elapsed}s</span>;
}
`,
);

write(
  "_components/search.tsx",
  `
"use client";
import { useState } from "react";

export function Search({ placeholder = "Search..." }: { placeholder?: string }) {
  const [query, setQuery] = useState("");
  return (
    <div style={{ marginBottom: "1rem" }}>
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={placeholder}
        style={{ padding: "0.5rem", border: "1px solid #ddd", borderRadius: "4px", width: "300px" }}
      />
      {query && <p style={{ fontSize: "0.8rem", color: "#666" }}>Searching for: {query}</p>}
    </div>
  );
}
`,
);

// ─── About ─────────────────────────────────────────────────────────────────────
write(
  "about/page.tsx",
  `
export const metadata = { title: "About" };
export default function AboutPage() {
  return (
    <div>
      <h1>About</h1>
      <p>This is a benchmark application for comparing Next.js and vinext (Vite) performance.</p>
      <p>It includes 33 routes with nested layouts, dynamic routes, server components, client components, and metadata.</p>
    </div>
  );
}
`,
);

// ─── Products section (dynamic + layout) ───────────────────────────────────────
write(
  "products/layout.tsx",
  `
export default function ProductsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div style={{ padding: "0.5rem", background: "#f0f0f0", marginBottom: "1rem" }}>
        <strong>Products</strong> — <a href="/products">All</a>
      </div>
      {children}
    </div>
  );
}
`,
);

// Pre-compute product prices at generation time with seeded PRNG for reproducibility.
const productPrices = Array.from({ length: 20 }, () =>
  (Math.round(random() * 10000) / 100).toFixed(2),
);

write(
  "products/page.tsx",
  `
import Link from "next/link";
export const metadata = { title: "Products" };

const products = [
${productPrices.map((price, i) => `  { id: ${i + 1}, name: "Product ${i + 1}", price: ${price} },`).join("\n")}
];

export default function ProductsPage() {
  return (
    <div>
      <h1>Products</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "1rem" }}>
        {products.map(p => (
          <Link key={p.id} href={\`/products/\${p.id}\`} style={{ padding: "1rem", border: "1px solid #ddd", textDecoration: "none", color: "inherit" }}>
            <h3>{p.name}</h3>
            <p>\${p.price}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
`,
);

write(
  "products/[id]/page.tsx",
  `
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: \`Product \${id}\` };
}
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <h1>Product {id}</h1>
      <p>This is the detail page for product {id}. Rendered at {new Date().toISOString()}</p>
    </div>
  );
}
`,
);

// ─── Blog section (25 posts) ───────────────────────────────────────────────────
write(
  "blog/layout.tsx",
  `
import { Search } from "../_components/search";
export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div style={{ padding: "0.5rem", background: "#f5f5ff", marginBottom: "1rem" }}>
        <strong>Blog</strong> — <a href="/blog">All Posts</a>
      </div>
      <Search placeholder="Search posts..." />
      {children}
    </div>
  );
}
`,
);

write(
  "blog/page.tsx",
  `
import Link from "next/link";
export const metadata = { title: "Blog" };
const posts = Array.from({ length: 25 }, (_, i) => ({
  slug: \`post-\${i + 1}\`,
  title: \`Blog Post \${i + 1}: \${["React Patterns", "Server Components", "Caching", "Deployment", "Performance"][i % 5]}\`,
  date: new Date(2025, 0, i + 1).toLocaleDateString(),
}));
export default function BlogPage() {
  return (
    <div>
      <h1>Blog</h1>
      {posts.map(post => (
        <article key={post.slug} style={{ marginBottom: "1rem", paddingBottom: "1rem", borderBottom: "1px solid #eee" }}>
          <Link href={\`/blog/\${post.slug}\`}><h2>{post.title}</h2></Link>
          <time>{post.date}</time>
        </article>
      ))}
    </div>
  );
}
`,
);

write(
  "blog/[slug]/page.tsx",
  `
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: slug.replace(/-/g, " ") };
}
export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const paragraphs = Array.from({ length: 5 }, (_, i) =>
    \`Paragraph \${i + 1} of "\${slug}". Lorem ipsum dolor sit amet, consectetur adipiscing elit.\`
  );
  return (
    <div>
      <h1>{slug.replace(/-/g, " ")}</h1>
      <time>{new Date().toLocaleDateString()}</time>
      {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
    </div>
  );
}
`,
);

// ─── Dashboard (nested layout + client components) ─────────────────────────────
write(
  "dashboard/layout.tsx",
  `
import { Timer } from "../_components/timer";
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px 1fr" }}>
      <aside style={{ padding: "1rem", borderRight: "1px solid #eee" }}>
        <h3>Dashboard</h3>
        <nav style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <a href="/dashboard">Overview</a>
          <a href="/dashboard/analytics">Analytics</a>
          <a href="/dashboard/users">Users</a>
          <a href="/dashboard/settings">Settings</a>
        </nav>
        <div style={{ marginTop: "1rem", fontSize: "0.8rem", color: "#666" }}><Timer /></div>
      </aside>
      <div style={{ padding: "1rem" }}>{children}</div>
    </div>
  );
}
`,
);

write(
  "dashboard/page.tsx",
  `
import { Counter } from "../_components/counter";
export const metadata = { title: "Dashboard" };
export default function DashboardPage() {
  const stats = [
    { label: "Total Users", value: "12,345" },
    { label: "Revenue", value: "$98,765" },
    { label: "Orders", value: "3,456" },
    { label: "Conversion", value: "3.2%" },
  ];
  return (
    <div>
      <h1>Dashboard Overview</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1rem", marginBottom: "2rem" }}>
        {stats.map(s => (
          <div key={s.label} style={{ padding: "1rem", border: "1px solid #ddd", borderRadius: "8px" }}>
            <div style={{ fontSize: "0.8rem", color: "#666" }}>{s.label}</div>
            <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{s.value}</div>
          </div>
        ))}
      </div>
      <Counter label="Page Views" />
    </div>
  );
}
`,
);

// Pre-compute analytics data at generation time with seeded PRNG for reproducibility.
const analyticsRows = Array.from({ length: 10 }, () => ({
  views: Math.floor(random() * 10000),
  bounce: Math.floor(random() * 100),
}));

write(
  "dashboard/analytics/page.tsx",
  `
export const metadata = { title: "Analytics" };

const rows = [
${analyticsRows.map((r, i) => `  { page: "/page-${i + 1}", views: ${r.views}, bounce: ${r.bounce} },`).join("\n")}
];

export default function AnalyticsPage() {
  return (
    <div>
      <h1>Analytics</h1>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th>Page</th><th>Views</th><th>Bounce Rate</th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.page} style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "0.5rem" }}>{r.page}</td>
            <td style={{ padding: "0.5rem" }}>{r.views.toLocaleString()}</td>
            <td style={{ padding: "0.5rem" }}>{r.bounce}%</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
`,
);

write(
  "dashboard/users/page.tsx",
  `
export const metadata = { title: "Users" };
export default function UsersPage() {
  const users = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1, name: \`User \${i + 1}\`, email: \`user\${i + 1}@example.com\`, role: i % 3 === 0 ? "Admin" : "User",
  }));
  return (
    <div>
      <h1>Users</h1>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Role</th></tr></thead>
        <tbody>{users.map(u => (
          <tr key={u.id} style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "0.5rem" }}>{u.id}</td><td style={{ padding: "0.5rem" }}>{u.name}</td>
            <td style={{ padding: "0.5rem" }}>{u.email}</td><td style={{ padding: "0.5rem" }}>{u.role}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
`,
);

write(
  "dashboard/settings/page.tsx",
  `
import { Counter } from "../../_components/counter";
export const metadata = { title: "Dashboard Settings" };
export default function DashboardSettingsPage() {
  return (<div><h1>Dashboard Settings</h1><p>Configure dashboard preferences.</p><Counter label="Saves" /></div>);
}
`,
);

// ─── Docs (catch-all) ──────────────────────────────────────────────────────────
write(
  "docs/page.tsx",
  `
import Link from "next/link";
export const metadata = { title: "Documentation" };
const sections = ["getting-started", "installation", "configuration", "api-reference", "deployment", "troubleshooting", "migration", "plugins"];
export default function DocsIndex() {
  return (<div><h1>Documentation</h1><ul>{sections.map(s => <li key={s}><Link href={\`/docs/\${s}\`}>{s.replace(/-/g, " ")}</Link></li>)}</ul></div>);
}
`,
);

write(
  "docs/[...slug]/page.tsx",
  `
export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return { title: \`Docs: \${slug.join(" / ")}\` };
}
export default async function DocPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return (<div><h1>Docs: {slug.join(" / ")}</h1>{Array.from({ length: 3 }, (_, i) => <p key={i}>Section {i + 1} content.</p>)}</div>);
}
`,
);

// ─── Settings (nested layout) ──────────────────────────────────────────────────
write(
  "settings/layout.tsx",
  `
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", gap: "1rem", padding: "0.5rem", background: "#fafafa", marginBottom: "1rem" }}>
        <a href="/settings">General</a>
        <a href="/settings/profile">Profile</a>
        <a href="/settings/notifications">Notifications</a>
        <a href="/settings/billing">Billing</a>
      </div>
      {children}
    </div>
  );
}
`,
);

for (const page of ["", "profile", "notifications", "billing"]) {
  const name = page || "General";
  const dir = page ? `settings/${page}` : "settings";
  write(
    `${dir}/page.tsx`,
    `
export const metadata = { title: "Settings - ${name}" };
export default function Settings${name.charAt(0).toUpperCase() + name.slice(1)}Page() {
  return (<div><h1>Settings: ${name}</h1><p>Configure ${name.toLowerCase()} settings.</p></div>);
}
  `,
  );
}

// ─── API routes ────────────────────────────────────────────────────────────────
write(
  "api/health/route.ts",
  `
export function GET() {
  return Response.json({ status: "ok", timestamp: Date.now() });
}
`,
);

write(
  "api/data/route.ts",
  `
export function GET() {
  const data = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, value: Math.random(), label: \`Item \${i + 1}\` }));
  return Response.json(data);
}
`,
);

// ─── Additional static pages (volume) ──────────────────────────────────────────
const staticPages = [
  "features",
  "pricing",
  "team",
  "careers",
  "contact",
  "faq",
  "terms",
  "privacy",
  "changelog",
  "roadmap",
  "support",
  "community",
  "partners",
  "press",
  "security",
];

for (const page of staticPages) {
  const title = page.charAt(0).toUpperCase() + page.slice(1);
  write(
    `${page}/page.tsx`,
    `
export const metadata = { title: "${title}" };
export default function ${title}Page() {
  return (
    <div>
      <h1>${title}</h1>
      <p>This is the ${page} page with information about ${page}.</p>
      ${
        page === "faq"
          ? `
      <div>
        {Array.from({ length: 10 }, (_, i) => (
          <details key={i} style={{ marginBottom: "0.5rem" }}>
            <summary>Question {i + 1}?</summary>
            <p>Answer to question {i + 1}.</p>
          </details>
        ))}
      </div>`
          : `
      <p>More content for the ${page} section would go here.</p>`
      }
    </div>
  );
}
  `,
  );
}

// Count results
import { readdirSync, statSync } from "node:fs";
function countFiles(dir, name) {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) count += countFiles(full, name);
    else if (entry === name) count++;
  }
  return count;
}

const pages = countFiles(APP, "page.tsx");
const routes = countFiles(APP, "route.ts");
console.log(
  `Generated benchmark app: ${pages} pages + ${routes} API routes = ${pages + routes} total routes`,
);

// Copy to each benchmark project (symlinks don't work with Turbopack)
import { cpSync } from "node:fs";
const BASE = dirname(new URL(import.meta.url).pathname);
for (const project of ["nextjs", "vinext", "vinext-rolldown"]) {
  const dest = join(BASE, project, "app");
  rmSync(dest, { recursive: true, force: true });
  cpSync(APP, dest, { recursive: true });
  console.log(`  Copied to ${project}/app`);
}
