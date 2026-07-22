import { useParams, useSearchParams } from "next/navigation";

type Props = {
  slug: string;
};

const PagesNavCompatGip = Object.assign(
  function PagesNavCompatGip({ slug }: Props) {
    const params = useParams();
    const searchParams = useSearchParams();
    const searchObject = Object.fromEntries(searchParams ? searchParams.entries() : []);
    return (
      <div>
        <pre id="gip-slug">{slug}</pre>
        <pre id="use-params">{JSON.stringify(params)}</pre>
        <pre id="use-search-params">{JSON.stringify(searchObject)}</pre>
      </div>
    );
  },
  {
    getInitialProps({ query }: { query: { slug?: string } }) {
      return {
        slug: query.slug ?? "",
      };
    },
  },
);

export default PagesNavCompatGip;
