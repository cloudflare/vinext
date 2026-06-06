import { useParams, useSearchParams } from "next/navigation";

type Props = {
  slug: string;
};

export function getStaticPaths() {
  return {
    paths: [{ params: { slug: "foobar" } }],
    fallback: false,
  };
}

export function getStaticProps({ params }: { params: { slug: string } }) {
  return {
    props: {
      slug: params.slug,
    },
  };
}

export default function PagesNavCompatGsp({ slug }: Props) {
  const params = useParams();
  const searchParams = useSearchParams();
  const searchObject = Object.fromEntries(searchParams ? searchParams.entries() : []);
  return (
    <div>
      <pre id="gsp-slug">{slug}</pre>
      <pre id="use-params">{JSON.stringify(params)}</pre>
      <pre id="use-search-params">{JSON.stringify(searchObject)}</pre>
    </div>
  );
}
