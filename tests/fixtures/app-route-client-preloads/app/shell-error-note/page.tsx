import { ShellErrorNote } from "../shell-error/shell-error-note";

// Another route rendering the note, so it doesn't share the thrower's
// stylesheet.
export default function ShellErrorNotePage() {
  return <ShellErrorNote />;
}
