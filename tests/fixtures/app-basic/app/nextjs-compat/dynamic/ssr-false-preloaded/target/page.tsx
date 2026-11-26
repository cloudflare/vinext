import { Loader } from "./loader";

export default function Page() {
  return (
    <>
      <h1 id="ssr-false-preloaded-heading">target</h1>
      <Loader />
    </>
  );
}
