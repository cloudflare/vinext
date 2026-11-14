import { Second } from "../second";

// Another route rendering Second, so it doesn't share First's stylesheet.
export default function SecondPage() {
  return <Second />;
}
