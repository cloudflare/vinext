// Used by E2E: app-router-encoded-basepath-i18n/pages-request-url.spec.ts.
// Under basePath "/docs", this page's URL starts with the basePath twice.
import type { GetServerSideProps } from "next";
import { useRouter } from "next/router";

type Props = {
  reqUrl: string;
};

export const getServerSideProps: GetServerSideProps<Props> = async ({ req }) => {
  return { props: { reqUrl: req.url ?? "" } };
};

export default function PagesRequestUrl({ reqUrl }: Props) {
  const { asPath } = useRouter();
  return <pre id="pages-request-url">{JSON.stringify({ asPath, reqUrl })}</pre>;
}
