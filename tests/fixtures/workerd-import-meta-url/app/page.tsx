import { modulePath } from "dep-with-guard";

export default function Page() {
  return <div data-testid="module-path">{modulePath}</div>;
}
