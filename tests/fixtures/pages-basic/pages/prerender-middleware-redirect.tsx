// Middleware redirects this URL at request time (see middleware.ts). The build
// still prerenders the filesystem path, as Next.js does; middleware only decides
// at request time which URL serves it. Coverage: tests/prerender.test.ts
export default function PrerenderMiddlewareRedirect() {
  return <h1>Prerender Middleware Redirect</h1>;
}
