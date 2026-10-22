import type { Metadata } from "next";

export const metadata: Metadata = {
  openGraph: {
    emails: ["a@example.com", "b@example.com"],
    phoneNumbers: ["+1 555 0100", "+1 555 0101"],
    faxNumbers: ["+1 555 0199"],
    alternateLocale: ["fr_FR", "de_DE"],
  },
};

export default function Page() {
  return <div id="opengraph-contact">OpenGraph contact and locale lists page</div>;
}
