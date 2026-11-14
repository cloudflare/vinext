import { Second } from "./second";

// A boundary that reaches the page's second import, and preloads it first.
export default function NotFound() {
  return <Second />;
}
