import type { GetStaticProps } from "next";

type Props = { renderedAt: string };

export const getStaticProps: GetStaticProps<Props> = () => ({
  props: { renderedAt: new Date().toISOString() },
  revalidate: 3600,
});

export default function PagesIsrPage({ renderedAt }: Props) {
  return <main data-testid="pages-isr-timestamp">Rendered at: {renderedAt}</main>;
}
