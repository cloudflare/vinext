import { Badge } from "../components/badge";

// A custom not-found page that renders the badge `_app` also renders.
export default function NotFound() {
  return (
    <main data-page="not-found">
      <Badge testId="page-badge" />
    </main>
  );
}
