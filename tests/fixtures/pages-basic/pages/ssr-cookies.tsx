type Props = {
  cookies: Record<string, string>;
};

export async function getServerSideProps({ req }: { req: { cookies: Record<string, string> } }) {
  return {
    props: {
      cookies: req.cookies,
    },
  };
}

export default function SsrCookies({ cookies }: Props) {
  return <pre id="cookies">{JSON.stringify(cookies)}</pre>;
}
