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

