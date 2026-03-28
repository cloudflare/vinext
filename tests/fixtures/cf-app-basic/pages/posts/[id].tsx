interface PostProps {
  id: string;
}

export default function Post({ id }: PostProps) {
  return (
    <div>
      <h1>Post: {id}</h1>
    </div>
  );
}

export async function getStaticPaths() {
  return {
    paths: [{ params: { id: "first" } }, { params: { id: "second" } }],
    fallback: false,
  };
}

export async function getStaticProps({ params }: { params: { id: string } }) {
  return {
    props: { id: params.id },
  };
}
