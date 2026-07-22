export default function MiddlewareGeneralErrorThrow({ message }: { message: string }) {
  return <p className={message}>{message}</p>;
}

export const getServerSideProps = ({ query }: { query: { message?: string } }) => ({
  props: { message: query.message ?? "" },
});
