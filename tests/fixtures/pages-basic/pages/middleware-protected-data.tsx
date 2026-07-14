export async function getServerSideProps() {
  return {
    props: {
      confidentialValue: "only visible after middleware",
    },
  };
}

export default function MiddlewareProtectedData({
  confidentialValue,
}: {
  confidentialValue: string;
}) {
  return <p>{confidentialValue}</p>;
}
