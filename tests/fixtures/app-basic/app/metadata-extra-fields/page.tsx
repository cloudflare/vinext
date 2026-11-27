import type { Metadata } from "next";

// Metadata fields Next.js renders in lib/metadata/metadata.tsx. `assets` uses
// the single-string form, which Next.js resolves to an array.
export const metadata: Metadata = {
  metadataBase: new URL("https://example.com"),
  title: "Metadata Extra Fields",
  abstract: "Page abstract",
  classification: "Page classification",
  archives: ["https://example.com/archives"],
  assets: "https://example.com/assets",
  bookmarks: ["https://example.com/bookmarks", "https://example.com/bookmarks/2"],
  pagination: {
    previous: "/metadata-extra-fields?page=1",
    next: "/metadata-extra-fields?page=3",
  },
  facebook: {
    appId: "12345678",
    admins: ["120", "122"],
  },
  pinterest: {
    richPin: true,
  },
};

export default function MetadataExtraFieldsPage() {
  return <h1>Metadata Extra Fields</h1>;
}
