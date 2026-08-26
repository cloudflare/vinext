export async function getServerSideProps({ res }: { res: { setHeader(name: string, value: string): void } }) {
  res.setHeader("Cache-Control", "s-maxage=300");
  return { props: {} };
}

export default function UserPolicyPagesSsr() {
  return <h1>Pages SSR with a response cache policy</h1>;
}
