import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";

const Page = ({ id }) => {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  if (typeof window !== "undefined" && id === "error") {
    throw new Error("Simulated client-side render error");
  }

  useEffect(() => {
    const handler = () => {
      setReady(true);
    };
    router.events.on("routeChangeComplete", handler);
    return () => {
      router.events.off("routeChangeComplete", handler);
    };
  }, [router]);

  return (
    <>
      <div
        style={{
          width: 10000,
          height: 10000,
          background: "blue",
        }}
      />
      <p>{ready ? "routeChangeComplete" : "loading"}</p>
      <Link
        href={`/${Number(id) + 1}`}
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
  const { id = "0" } = context.query;
  return {
    props: {
      id,
    },
  };
};
