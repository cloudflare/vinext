import { FOOTER_LINKS } from "./footer-links";

export function SiteFooter() {
  return (
    <footer data-marker="marker-site-footer">
      {FOOTER_LINKS.length} links, first: {FOOTER_LINKS[0]!.label}
    </footer>
  );
}
