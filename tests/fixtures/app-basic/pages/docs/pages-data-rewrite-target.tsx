import type { GetServerSideProps } from "next";

type Props = {
  message: string;
};

export const getServerSideProps: GetServerSideProps<Props> = async ({ res }) => {
  res.setHeader("Set-Cookie", "pages-rewrite-session=gssp; Path=/");
  return { props: { message: "concrete Pages GSSP" } };
};

export default function PagesDataRewriteTarget({ message }: Props) {
  return <p id="pages-data-rewrite-result">{message}</p>;
}
