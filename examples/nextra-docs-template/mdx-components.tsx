import type { MDXComponents } from "mdx/types";
import Link from "next/link";

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...components,
    a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
      const href = props.href;
      if (href && href.startsWith("/")) {
        return <Link {...props} href={href} />;
      }
      return <a target="_blank" rel="noopener noreferrer" {...props} />;
    },
    code: (props: React.HTMLAttributes<HTMLElement>) => (
      <code
        style={{
          backgroundColor: "var(--code-bg)",
          padding: "0.15em 0.35em",
          borderRadius: "4px",
          fontSize: "0.9em",
        }}
        {...props}
      />
    ),
    pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
      <pre
        style={{
          backgroundColor: "var(--code-bg)",
          padding: "1rem",
          borderRadius: "8px",
          overflow: "auto",
          fontSize: "0.875rem",
          lineHeight: 1.7,
        }}
        {...props}
      />
    ),
  };
}
