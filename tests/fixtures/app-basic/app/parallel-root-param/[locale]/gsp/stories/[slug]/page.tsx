export { default } from "../../../no-gsp/stories/[slug]/page";

export function generateStaticParams() {
  return [{ slug: "static-123" }];
}
