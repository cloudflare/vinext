import type { GetServerSidePropsResult } from "next";

interface SSRProps {
  message: string;
  timestamp: string;
}

export async function getServerSideProps(): Promise<GetServerSidePropsResult<SSRProps>> {
  return {
    props: {
      message: "Server-Side Rendered on Workers",
      timestamp: new Date().toISOString(),
    },
  };
}

export default function SSRPage({ message, timestamp }: SSRProps) {
  return (
    <>
      <h1>{message}</h1>
      <p>Generated at: {timestamp}</p>
    </>
  );
}
