/**
 * Next.js compat: global-error/basic — layout generateMetadata errors should
 * propagate into the nearest error boundary instead of being swallowed.
 */
export function generateMetadata() {
  throw new Error("Layout metadata error");
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <section>{children}</section>;
}
