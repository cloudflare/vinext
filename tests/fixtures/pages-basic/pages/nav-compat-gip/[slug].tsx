import { useParams, useSearchParams } from "next/navigation";

type Props = {
  slug: string;
  executedOn: "client" | "server";
};

const PagesNavCompatGip = Object.assign(
  function PagesNavCompatGip({ slug, executedOn }: Props) {
    const params = useParams();
    const searchParams = useSearchParams();
    const searchObject = Object.fromEntries(searchParams ? searchParams.entries() : []);
    return (
      <div>
        <pre id="gip-slug">{slug}</pre>
        <pre id="gip-executed-on">{executedOn}</pre>
        <pre id="use-params">{JSON.stringify(params)}</pre>
        <pre id="use-search-params">{JSON.stringify(searchObject)}</pre>
      </div>
    );
  },
  {
    getInitialProps({ query }: { query: { slug?: string } }) {
      return {
        slug: query.slug ?? "",
        executedOn: typeof window === "undefined" ? "server" : "client",
      };
    },
  },
);

export default PagesNavCompatGip;
