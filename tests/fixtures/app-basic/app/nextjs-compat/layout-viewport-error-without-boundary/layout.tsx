/**
 * Next.js compat: layout generateViewport errors without a local error
 * boundary should escalate to global-error.tsx.
 */
export function generateViewport() {
  throw new Error("Layout viewport error");
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <section>{children}</section>;
}
