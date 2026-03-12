import type { Metadata } from "next";

export const metadata: Metadata = {
  other: {
    "fb:app_id": "12345678",
    "fb:admins": ["87654321", "11223344", "55667788"],
    "pinterest-rich-pin": "false",
  },
};

export default function Page() {
  return <div id="metadata-socials">Metadata socials page</div>;
}
