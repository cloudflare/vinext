import type { Metadata } from "next";

export const metadata: Metadata = {
  openGraph: {
    emails: "a@example.com",
    phoneNumbers: "+1 555 0100",
    faxNumbers: "+1 555 0199",
    alternateLocale: "fr_FR",
  },
};

export default function Page() {
  return <div id="opengraph-contact-single">OpenGraph single contact and locale page</div>;
}
