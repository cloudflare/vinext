// Ported from Next.js: test/integration/next-dynamic/pages/index.js
// https://github.com/vercel/next.js/blob/canary/test/integration/next-dynamic/pages/index.js
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import FourDirect from "../../components/next-dynamic/four";

const One = dynamic(() => import("../../components/next-dynamic/one"));
const Two = dynamic(() => import("../../components/next-dynamic/two"));
const Three = dynamic(() => import("../../components/next-dynamic/three"));
const Four = dynamic(() => import("../../components/next-dynamic/four"));

export default function NextDynamicPage() {
  const [firstRender, setFirstRender] = useState("the-server-value");
  useEffect(() => {
    setFirstRender(document.getElementById("foo")!.innerHTML);
  }, []);

  return (
    <>
      <div id="foo">
        Index
        <One />
        <Two />
        <Three />
        <Four />
        <FourDirect />
      </div>
      <div id="first-render">{firstRender}</div>
    </>
  );
}
