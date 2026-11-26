// Only resolvable where tsconfig `paths` targets with `\` separators are
// native paths (Windows).
import api from "@win/foo";

export default function Home() {
  return <div>{api()}</div>;
}
