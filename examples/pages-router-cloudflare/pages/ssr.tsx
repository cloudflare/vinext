import type { GetServerSidePropsResult } from "next";

interface SSRProps {
  message: string;
  timestamp: string;
  runtime: string;
}

export async function getServerSideProps(): Promise<
  GetServerSidePropsResult<SSRProps>
> {
  return {
    props: {
      message: "Server-Side Rendered on Workers",
      timestamp: new Date().toISOString(),
      runtime:
        typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    },
  };
}

export default function SSRPage({ message, timestamp, runtime }: SSRProps) {
  return (
    <>
      <h1>{message}</h1>
      <p>Generated at: {timestamp}</p>
      <span data-testid="runtime">{runtime}</span>
    </>
  );
}
