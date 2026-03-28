import type { CSSProperties } from "react";

export const s = {
  // Layout
  page: {
    display: "flex",
    flexDirection: "column",
    gap: "1.5rem",
  } satisfies CSSProperties,

  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "1rem",
    padding: "3rem 1rem",
    textAlign: "center",
  } satisfies CSSProperties,

  // Card
  card: {
    background: "var(--card-bg)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "1.25rem",
    boxShadow: "var(--card-shadow)",
  } satisfies CSSProperties,

  // Typography
  title: {
    fontSize: "1.75rem",
    fontWeight: 700,
  } satisfies CSSProperties,

  subtitle: {
    color: "var(--muted)",
    marginTop: "0.25rem",
  } satisfies CSSProperties,

  label: {
    fontSize: "0.8rem",
    fontFamily: "var(--mono)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--muted)",
    marginBottom: "0.75rem",
  } satisfies CSSProperties,

  mono: {
    fontFamily: "var(--mono)",
    fontSize: "0.8rem",
    color: "var(--muted)",
  } satisfies CSSProperties,

  badge: {
    display: "inline-block",
    fontSize: "0.75rem",
    fontFamily: "var(--mono)",
    background: "var(--border)",
    color: "var(--muted)",
    padding: "0.15rem 0.5rem",
    borderRadius: 4,
  } satisfies CSSProperties,

  tag: {
    fontSize: "0.8rem",
    background: "var(--border)",
    padding: "0.15rem 0.5rem",
    borderRadius: 4,
  } satisfies CSSProperties,

  // Definition list
  dl: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    gap: "0.25rem 1rem",
    fontSize: "0.875rem",
  } satisfies CSSProperties,

  dt: { fontWeight: 600 } satisfies CSSProperties,

  dd: {
    fontFamily: "var(--mono)",
    fontSize: "0.8rem",
    color: "var(--muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,

  // Form
  input: {
    padding: "0.5rem 0.75rem",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "var(--bg)",
    color: "var(--fg)",
    fontSize: "0.875rem",
    flex: 1,
  } satisfies CSSProperties,

  btn: {
    padding: "0.5rem 1rem",
    border: "none",
    borderRadius: "var(--radius)",
    background: "var(--accent)",
    color: "#fff",
    fontSize: "0.875rem",
    cursor: "pointer",
  } satisfies CSSProperties,

  btnOutline: {
    padding: "0.4rem 0.75rem",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "var(--card-bg)",
    color: "var(--fg)",
    fontSize: "0.8rem",
    cursor: "pointer",
  } satisfies CSSProperties,

  // Flex helpers
  row: {
    display: "flex",
    gap: "0.5rem",
    flexWrap: "wrap",
  } satisfies CSSProperties,
} as const;
