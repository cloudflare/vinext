#!/bin/bash
# Generate a realistic benchmark app with 50+ pages.
# The app/ directory is shared between Next.js and vinext projects.
set -euo pipefail

APP_DIR="$(dirname "$0")/app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"

# ─── Root layout ────────────────────────────────────────────────────────────────
cat > "$APP_DIR/layout.tsx" << 'EOF'
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
EOF

# ─── Home page (server component) ──────────────────────────────────────────────
cat > "$APP_DIR/page.tsx" << 'EOF'
export default function Home() {
  const now = new Date().toISOString();
  return (
    <div>
      <h1>Benchmark App</h1>
      <p>Server-rendered at {now}</p>
      <p>This is a realistic benchmark app with 50+ pages, nested layouts, dynamic routes, and client components.</p>
    </div>
  );
}
EOF

# ─── Client component (shared) ─────────────────────────────────────────────────
mkdir -p "$APP_DIR/_components"
cat > "$APP_DIR/_components/counter.tsx" << 'EOF'
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
EOF

cat > "$APP_DIR/_components/timer.tsx" << 'EOF'
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
EOF

# ─── About page (static) ───────────────────────────────────────────────────────
mkdir -p "$APP_DIR/about"
cat > "$APP_DIR/about/page.tsx" << 'EOF'
export const metadata = { title: "About" };

export default function AboutPage() {
  return (
    <div>
      <h1>About</h1>
      <p>This is a benchmark application for comparing Next.js and vinext (Vite) performance.</p>
      <p>It includes 50+ pages with nested layouts, dynamic routes, server components, client components, and metadata.</p>
    </div>
  );
}
EOF

# ─── Products section (dynamic routes + layout) ────────────────────────────────
mkdir -p "$APP_DIR/products/[id]"
cat > "$APP_DIR/products/layout.tsx" << 'EOF'
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
EOF

cat > "$APP_DIR/products/page.tsx" << 'EOF'
import Link from "next/link";
export const metadata = { title: "Products" };

const products = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  name: `Product ${i + 1}`,
  price: Math.round(Math.random() * 10000) / 100,
}));

export default function ProductsPage() {
  return (
    <div>
      <h1>Products</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "1rem" }}>
        {products.map(p => (
          <Link key={p.id} href={`/products/${p.id}`} style={{ padding: "1rem", border: "1px solid #ddd", textDecoration: "none", color: "inherit" }}>
            <h3>{p.name}</h3>
            <p>${p.price}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
EOF

cat > "$APP_DIR/products/[id]/page.tsx" << 'EOF'
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Product ${id}` };
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <h1>Product {id}</h1>
      <p>This is the detail page for product {id}.</p>
      <p>Rendered at {new Date().toISOString()}</p>
    </div>
  );
}
EOF

# ─── Blog section (many pages + catch-all) ──────────────────────────────────────
mkdir -p "$APP_DIR/blog/[slug]"
cat > "$APP_DIR/blog/layout.tsx" << 'EOF'
export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div style={{ padding: "0.5rem", background: "#f5f5ff", marginBottom: "1rem" }}>
        <strong>Blog</strong> — <a href="/blog">All Posts</a>
      </div>
      {children}
    </div>
  );
}
EOF

cat > "$APP_DIR/blog/page.tsx" << 'EOF'
import Link from "next/link";
export const metadata = { title: "Blog" };

const posts = Array.from({ length: 25 }, (_, i) => ({
  slug: `post-${i + 1}`,
  title: `Blog Post ${i + 1}: ${["React Patterns", "Server Components", "Caching Strategies", "Deployment Tips", "Performance Tuning"][i % 5]}`,
  date: new Date(2025, 0, i + 1).toLocaleDateString(),
}));

export default function BlogPage() {
  return (
    <div>
      <h1>Blog</h1>
      {posts.map(post => (
        <article key={post.slug} style={{ marginBottom: "1rem", paddingBottom: "1rem", borderBottom: "1px solid #eee" }}>
          <Link href={`/blog/${post.slug}`}><h2>{post.title}</h2></Link>
          <time>{post.date}</time>
        </article>
      ))}
    </div>
  );
}
EOF

cat > "$APP_DIR/blog/[slug]/page.tsx" << 'EOF'
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()) };
}

export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Simulate content
  const paragraphs = Array.from({ length: 5 }, (_, i) =>
    `This is paragraph ${i + 1} of the blog post "${slug}". Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`
  );
  return (
    <div>
      <h1>{slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</h1>
      <time>{new Date().toLocaleDateString()}</time>
      {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
    </div>
  );
}
EOF

# ─── Dashboard (nested layout + client components) ─────────────────────────────
mkdir -p "$APP_DIR/dashboard/analytics" "$APP_DIR/dashboard/users" "$APP_DIR/dashboard/settings"
cat > "$APP_DIR/dashboard/layout.tsx" << 'EOF'
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
        <div style={{ marginTop: "1rem", fontSize: "0.8rem", color: "#666" }}>
          <Timer />
        </div>
      </aside>
      <div style={{ padding: "1rem" }}>{children}</div>
    </div>
  );
}
EOF

cat > "$APP_DIR/dashboard/page.tsx" << 'EOF'
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
EOF

cat > "$APP_DIR/dashboard/analytics/page.tsx" << 'EOF'
export const metadata = { title: "Analytics" };
export default function AnalyticsPage() {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    page: `/page-${i + 1}`,
    views: Math.floor(Math.random() * 10000),
    bounce: Math.floor(Math.random() * 100),
  }));
  return (
    <div>
      <h1>Analytics</h1>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th>Page</th><th>Views</th><th>Bounce Rate</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.page} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: "0.5rem" }}>{r.page}</td>
              <td style={{ padding: "0.5rem" }}>{r.views.toLocaleString()}</td>
              <td style={{ padding: "0.5rem" }}>{r.bounce}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
EOF

cat > "$APP_DIR/dashboard/users/page.tsx" << 'EOF'
export const metadata = { title: "Users" };
export default function UsersPage() {
  const users = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1, name: `User ${i + 1}`, email: `user${i + 1}@example.com`, role: i % 3 === 0 ? "Admin" : "User",
  }));
  return (
    <div>
      <h1>Users</h1>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Role</th></tr></thead>
        <tbody>
          {users.map(u => (
            <tr key={u.id} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: "0.5rem" }}>{u.id}</td>
              <td style={{ padding: "0.5rem" }}>{u.name}</td>
              <td style={{ padding: "0.5rem" }}>{u.email}</td>
              <td style={{ padding: "0.5rem" }}>{u.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
EOF

cat > "$APP_DIR/dashboard/settings/page.tsx" << 'EOF'
import { Counter } from "../../_components/counter";
export const metadata = { title: "Settings" };
export default function SettingsPage() {
  return (
    <div>
      <h1>Settings</h1>
      <p>Configure your account preferences here.</p>
      <Counter label="Save Count" />
    </div>
  );
}
EOF

# ─── Docs section (catch-all route) ────────────────────────────────────────────
mkdir -p "$APP_DIR/docs/[...slug]"
cat > "$APP_DIR/docs/page.tsx" << 'EOF'
import Link from "next/link";
export const metadata = { title: "Documentation" };
const sections = ["getting-started", "installation", "configuration", "api-reference", "deployment", "troubleshooting"];
export default function DocsIndex() {
  return (
    <div>
      <h1>Documentation</h1>
      <ul>{sections.map(s => <li key={s}><Link href={`/docs/${s}`}>{s.replace(/-/g, " ")}</Link></li>)}</ul>
    </div>
  );
}
EOF

cat > "$APP_DIR/docs/[...slug]/page.tsx" << 'EOF'
export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return { title: slug.join(" / ") };
}
export default async function DocPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return (
    <div>
      <h1>Docs: {slug.join(" / ")}</h1>
      <p>Documentation content for {slug.join("/")}.</p>
      {Array.from({ length: 3 }, (_, i) => <p key={i}>Section {i + 1} content for this documentation page.</p>)}
    </div>
  );
}
EOF

# ─── Settings section ──────────────────────────────────────────────────────────
mkdir -p "$APP_DIR/settings/profile" "$APP_DIR/settings/notifications" "$APP_DIR/settings/billing"
cat > "$APP_DIR/settings/layout.tsx" << 'EOF'
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
EOF

for page in "" profile notifications billing; do
  dir="$APP_DIR/settings${page:+/$page}"
  mkdir -p "$dir"
  name="${page:-General}"
  cat > "$dir/page.tsx" << EOPAGE
export const metadata = { title: "Settings - ${name^}" };
export default function Settings${name^}Page() {
  return (
    <div>
      <h1>Settings: ${name^}</h1>
      <p>Configure your ${name:-general} settings here.</p>
    </div>
  );
}
EOPAGE
done

# ─── API route handlers ────────────────────────────────────────────────────────
mkdir -p "$APP_DIR/api/health" "$APP_DIR/api/data"
cat > "$APP_DIR/api/health/route.ts" << 'EOF'
export function GET() {
  return Response.json({ status: "ok", timestamp: Date.now() });
}
EOF

cat > "$APP_DIR/api/data/route.ts" << 'EOF'
export function GET() {
  const data = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    value: Math.random(),
    label: `Item ${i + 1}`,
  }));
  return Response.json(data);
}
EOF

# ─── Generate additional static pages for volume ───────────────────────────────
SECTIONS=("features" "pricing" "team" "careers" "contact" "faq" "terms" "privacy" "changelog" "roadmap")
for section in "${SECTIONS[@]}"; do
  mkdir -p "$APP_DIR/$section"
  cat > "$APP_DIR/$section/page.tsx" << EOPAGE
export const metadata = { title: "${section^}" };
export default function ${section^}Page() {
  return (
    <div>
      <h1>${section^}</h1>
      <p>This is the ${section} page. It contains information about ${section}.</p>
      ${section === "faq" && 'const faqs = Array.from({ length: 10 }, (_, i) => ({ q: `Question ${i+1}?`, a: `Answer ${i+1}.` }));'}
    </div>
  );
}
EOPAGE
done

# Count pages
PAGE_COUNT=$(find "$APP_DIR" -name "page.tsx" | wc -l | tr -d ' ')
ROUTE_COUNT=$(find "$APP_DIR" -name "route.ts" | wc -l | tr -d ' ')
echo "Generated benchmark app: $PAGE_COUNT pages + $ROUTE_COUNT API routes"
