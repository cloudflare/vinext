import api from "@lib/b-only";

export default function ResolveFallback() {
  return <div>{api()}</div>;
}
