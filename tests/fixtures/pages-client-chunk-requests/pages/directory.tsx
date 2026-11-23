import { FOOTER_LINKS } from "../lib/footer-links";
import { NAV_SECTIONS } from "../lib/nav-sections";

// Shares one large module with each of `_app`'s header and footer.
export default function Directory() {
  return (
    <ul data-page="directory">
      {[...NAV_SECTIONS.slice(0, 3), ...FOOTER_LINKS.slice(0, 3)].map((entry) => (
        <li key={entry.id}>{entry.label}</li>
      ))}
    </ul>
  );
}
