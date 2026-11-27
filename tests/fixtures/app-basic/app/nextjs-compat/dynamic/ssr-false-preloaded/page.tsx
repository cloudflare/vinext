import { PreloadLink } from "./preload-link";

export default function Page() {
  return (
    <PreloadLink
      id="ssr-false-preloaded-link"
      href="/nextjs-compat/dynamic/ssr-false-preloaded/target"
    >
      target
    </PreloadLink>
  );
}
