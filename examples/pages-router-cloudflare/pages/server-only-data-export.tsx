import { useEffect, useState } from "react";
import type { GetServerSideProps } from "next";
import { SERVER_ONLY_DATA_TOKEN } from "../lib/server-only-data";

interface Props {
  tokenLength: number;
}

export const getServerSideProps: GetServerSideProps<Props> = async () => ({
  props: { tokenLength: SERVER_ONLY_DATA_TOKEN.length },
});

export default function ServerOnlyDataExportPage({ tokenLength }: Props) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <>
      <h1>Server-only data export</h1>
      <p data-testid="token-length">{tokenLength}</p>
      <p data-testid="hydrated">{hydrated ? "yes" : "no"}</p>
    </>
  );
}
