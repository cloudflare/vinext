import type { Metadata } from "next";

// Layout exports a base OG image list via generateMetadata().
// The child page will access this via the `parent` parameter.
export async function generateMetadata(): Promise<Metadata> {
  return {
    openGraph: {
      images: ["/base-image.jpg"],
    },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
