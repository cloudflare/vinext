export default function SharePage() {
  return <h1>Shared record</h1>;
}

// Models a private share link opened without access: the request path is the
// secret, and the response is the shared /404 document.
export function getServerSideProps() {
  return { notFound: true };
}
