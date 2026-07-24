import type { GetServerSidePropsContext } from "next";

/**
 * Response-header side effect performed from getServerSideProps when the
 * corresponding trial arm is on.
 */
export const sendTightAssetPolicyHeader = (
  context: GetServerSidePropsContext,
  reportOnly: boolean,
): void => {
  const headerName = reportOnly
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";
  context.res.setHeader(
    headerName,
    "default-src 'self'; img-src 'self' https://media.atlas-fixture.test",
  );
};
