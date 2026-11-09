// Nothing under app/ imports fake-pages-only-lib, so the dev client optimizer
// only finds it by scanning pages/ at startup.
import { pagesOnlyMessage } from "fake-pages-only-lib";

export default function PagesOnlyDependencyPage() {
  return <p data-testid="pages-only-dependency">{pagesOnlyMessage}</p>;
}
