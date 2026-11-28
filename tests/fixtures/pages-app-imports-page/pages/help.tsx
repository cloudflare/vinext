import { HELP_LINKS } from "../lib/help-links";

// Shares the help links with the error page.
export default function Help() {
  return (
    <ul data-page="help">
      {HELP_LINKS.slice(0, 3).map((entry) => (
        <li key={entry.id}>{entry.label}</li>
      ))}
    </ul>
  );
}
