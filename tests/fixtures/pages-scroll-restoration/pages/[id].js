import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/router";

const Page = ({ id }) => {
  const router = useRouter();
  const idRef = useRef(id);
  idRef.current = id;
  const [lastEvent, setLastEvent] = useState({ url: null, id });

  if (typeof window !== "undefined" && id === "error") {
    throw new Error("Simulated client-side render error");
  }

  useEffect(() => {
    // Reset the readiness indicator whenever the page id changes so that
    // back/forward traversals must emit a fresh routeChangeComplete before
    // the fixture reports "ready" again.
    setLastEvent((prev) => (prev.id === idRef.current ? prev : { url: null, id: idRef.current }));

    const handler = (url) => {
      setLastEvent({ url, id: idRef.current });
    };
    router.events.on("routeChangeComplete", handler);
    return () => {
      router.events.off("routeChangeComplete", handler);
    };
  }, [router]);

  const ready = lastEvent.url !== null && lastEvent.id === id;

  return (
    <>
      <div
        style={{
          width: 10000,
          height: 10000,
          background: "blue",
        }}
      />
      <p>{ready ? `routeChangeComplete:${lastEvent.url}` : "loading"}</p>
      <Link
        href={`/${id + 1}`}
        id="link"
        style={{
          marginLeft: 5000,
          width: 95000,
          display: "block",
        }}
      >
        next page
      </Link>
      <div id="end-el">hello, world</div>
    </>
  );
};

export default Page;

export const getServerSideProps = (context) => {
  const { id = 0 } = context.query;
  return {
    props: {
      id,
    },
  };
};
