// The toolkit is a side-effect-free barrel. Only `formatTitle` is used, so the
// rest of it is tree-shaken out of the client bundle.
import { formatTitle } from "../vendor/toolkit";
import { NAV_SECTIONS } from "./nav-sections";

export function SiteHeader() {
  return (
    <header data-marker="marker-site-header">
      {formatTitle("site")} has {NAV_SECTIONS.length} sections, first: {NAV_SECTIONS[0]!.label}
    </header>
  );
}
