import type { Metadata } from "next";

export const metadata: Metadata = {
  icons: {
    icon: {
      url: "/metadata-icons-object/object-icon.png",
      sizes: "96x96",
      type: "image/png",
    },
  },
};

export default function MetadataIconsObjectPage() {
  return (
    <main>
      <h1>Metadata Icons Object</h1>
      <p>Single descriptor object for icons.icon.</p>
    </main>
  );
}
