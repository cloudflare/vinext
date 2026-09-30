import { ReactLazyHost } from "./react-lazy-host";
import { VERSION } from "../version";

export default function ReactLazyPage() {
  return (
    <main>
      <h1 id="target">React lazy {VERSION}</h1>
      <ReactLazyHost />
    </main>
  );
}
