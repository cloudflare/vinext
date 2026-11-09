// Its own getInitialProps makes the 404 page non-static, so its render gets
// the request; vinext still prerenders it. Shows whether the build's
// prerender secret reached user code.
export default function ErrorPage({ secret }) {
  return <p id="secret">{secret ?? "none"}</p>;
}

ErrorPage.getInitialProps = ({ req }) => ({
  secret: req?.headers["x-vinext-prerender-secret"],
});
