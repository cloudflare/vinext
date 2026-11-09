// As in `next build`, a hybrid build's `pages/404` that throws while
// prerendering fails the build, though the App Router's not-found page is
// the 404 page.
export default function NotFoundPage() {
  throw new Error("pages 404 failed");
}
