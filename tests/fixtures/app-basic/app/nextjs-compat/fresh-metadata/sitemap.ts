import { sharedImportedNow } from "../../../../shared/rsc-shared-now";

export default function sitemap() {
  return [
    {
      url: `https://example.com/fresh/${sharedImportedNow}`,
    },
  ];
}
