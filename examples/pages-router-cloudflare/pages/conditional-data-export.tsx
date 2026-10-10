import { useEffect, useState } from "react";
import type { GetServerSideProps } from "next";
import { PRIVATE_PAGE_ENABLED, PRIVATE_SIGNING_KEY } from "../lib/private-page-config";

interface Props {
  keyLength: number;
}

// A data export assigned inside a conditional branch must be stripped from the
// client build together with the server-only module it reads.
let getServerSideProps: GetServerSideProps<Props> | undefined;
if (PRIVATE_PAGE_ENABLED) {
  getServerSideProps = async () => ({
    props: { keyLength: PRIVATE_SIGNING_KEY.length },
  });
}
export { getServerSideProps };

export default function ConditionalDataExportPage({ keyLength }: Props) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <>
      <h1>Conditional data export</h1>
      <p data-testid="key-length">{keyLength}</p>
      <p data-testid="hydrated">{hydrated ? "yes" : "no"}</p>
    </>
  );
}
