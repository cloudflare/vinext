export { default } from "../../../no-gsp/stories/[slug]/page";

export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: "main" }];
}
