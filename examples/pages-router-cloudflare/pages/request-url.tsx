import type { GetServerSideProps } from "next";

interface RequestUrlProps {
  url: string | null;
  resolvedUrl: string;
}

export const getServerSideProps: GetServerSideProps<RequestUrlProps> = async ({
  req,
  resolvedUrl,
}) => ({
  props: { url: req.url ?? null, resolvedUrl },
});

export default function RequestUrlPage({ url, resolvedUrl }: RequestUrlProps) {
  return (
    <>
      <p data-testid="req-url">{url}</p>
      <p data-testid="resolved-url">{resolvedUrl}</p>
    </>
  );
}
