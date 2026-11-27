import type { Metadata } from "next";

// Single-string forms, which Next.js resolves to arrays before a nested
// segment's generateMetadata reads them from `parent`.
export const metadata: Metadata = {
  assets: "https://example.com/layout-assets",
  facebook: { admins: "100" },
};

export default function MetadataExtraFieldsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
