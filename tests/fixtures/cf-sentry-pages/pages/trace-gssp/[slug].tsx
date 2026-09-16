import * as Sentry from "@sentry/nextjs";
import type { GetServerSideProps } from "next";

export const getServerSideProps: GetServerSideProps<{ slug: string }> = async ({ params }) => {
  const slug = String(params?.slug ?? "");
  return Sentry.startSpan(
    {
      attributes: { "fixture.slug": slug },
      name: "fixture.pages.gssp.child",
      op: "fixture.gssp",
    },
    () => ({ props: { slug } }),
  );
};

export default function TraceGsspPage({ slug }: { slug: string }) {
  return <main>GSSP trace: {slug}</main>;
}
