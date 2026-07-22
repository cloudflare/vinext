/**
 * Next.js compat: layout generateViewport errors should propagate into the
 * nearest error boundary instead of being swallowed.
 */
export function generateViewport() {
  throw new Error("Layout viewport error");
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <section>{children}</section>;
}
