// As in `next build`, a `pages/404` that throws while prerendering fails the build.
export default function NotFoundPage() {
  throw new Error("404 page failed");
}
