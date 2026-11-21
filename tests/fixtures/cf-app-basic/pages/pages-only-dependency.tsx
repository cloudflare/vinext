// Nothing under app/ imports pages-only-dependency, so the dev optimizers only
// find it by scanning pages/ at startup.
import { pagesOnlyMessage } from "pages-only-dependency";

export default function PagesOnlyDependencyPage() {
  return <p data-testid="pages-only-dependency">{pagesOnlyMessage}</p>;
}
