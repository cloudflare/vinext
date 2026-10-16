import { getImageProps } from "next/image";

// Ported from Next.js: test/integration/next-image-new/app-dir/app/picture/page.js
// https://github.com/vercel/next.js/blob/canary/test/integration/next-image-new/app-dir/app/picture/page.js
// getImageProps is called from a Server Component, so it must not be a client reference.
export default function ImageGetImagePropsPage() {
  const common = { alt: "Hero", width: 400, height: 400, priority: true };
  const {
    props: { srcSet: dark },
  } = getImageProps({ ...common, src: "/get-image-props-dark.png" });
  const {
    props: { srcSet: light, ...rest },
  } = getImageProps({ ...common, src: "/get-image-props-light.png" });
  return (
    <picture>
      <source media="(prefers-color-scheme: dark)" srcSet={dark} />
      <source media="(prefers-color-scheme: light)" srcSet={light} />
      <img {...rest} />
    </picture>
  );
}
