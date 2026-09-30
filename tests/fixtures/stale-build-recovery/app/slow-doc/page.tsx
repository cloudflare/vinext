import { VERSION } from "../version";

export default function SlowDocumentPage() {
  return <h1 id="slow-target">{`Slow document ${VERSION}`}</h1>;
}
