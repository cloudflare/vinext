import * as Sentry from "@sentry/nextjs";
import type { GetStaticPaths, GetStaticProps } from "next";

export const getStaticPaths: GetStaticPaths = () => ({ fallback: "blocking", paths: [] });

export const getStaticProps: GetStaticProps<{ slug: string }> = async ({ params }) => {
  const slug = String(params?.slug ?? "");
  return Sentry.startSpan(
    {
      attributes: { "fixture.slug": slug },
      name: "fixture.pages.gsp.child",
      op: "fixture.gsp",
    },
    () => ({ props: { slug }, revalidate: 60 }),
  );
};

export default function TraceGspPage({ slug }: { slug: string }) {
  return <main>GSP trace: {slug}</main>;
}
