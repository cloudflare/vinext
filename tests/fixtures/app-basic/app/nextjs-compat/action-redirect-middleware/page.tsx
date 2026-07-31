import {
  redirectToBlockedPath,
  redirectToAbout,
  redirectToConfigRedirect,
  redirectToConfigRewrite,
  redirectToEncodedBlockedPath,
  redirectToMiddlewareRedirect,
  redirectToMiddlewareRewrite,
  redirectToPagesRoute,
} from "./actions";

export default function Page() {
  return (
    <main>
      <h1>Action Redirect Middleware Test</h1>
      <form action={redirectToBlockedPath}>
        <button id="redirect-to-blocked" type="submit">
          Redirect to blocked path
        </button>
      </form>
      <form action={redirectToEncodedBlockedPath}>
        <button id="redirect-to-encoded-blocked" type="submit">
          Redirect to encoded blocked path
        </button>
      </form>
      <form action={redirectToMiddlewareRewrite}>
        <button id="redirect-to-middleware-rewrite" type="submit">
          Redirect through middleware rewrite
        </button>
      </form>
      <form action={redirectToConfigRewrite}>
        <button id="redirect-to-config-rewrite" type="submit">
          Redirect through config rewrite
        </button>
      </form>
      <form action={redirectToMiddlewareRedirect}>
        <button id="redirect-to-middleware-redirect" type="submit">
          Redirect through middleware redirect
        </button>
      </form>
      <form action={redirectToConfigRedirect}>
        <button id="redirect-to-config-redirect" type="submit">
          Redirect through config redirect
        </button>
      </form>
      <form action={redirectToAbout}>
        <button id="redirect-to-about" type="submit">
          Redirect to about
        </button>
      </form>
      <form action={redirectToPagesRoute}>
        <button id="redirect-to-pages-route" type="submit">
          Redirect to Pages Router
        </button>
      </form>
    </main>
  );
}
