interface SSRPageProps {
  timestamp: string;
  message: string;
}

export default function SSRPage({ timestamp, message }: SSRPageProps) {
  return (
    <div>
      <h1>Server-Side Rendered</h1>
      <p data-testid="message">{message}</p>
      <p data-testid="timestamp">Rendered at: {timestamp}</p>
    </div>
  );
}

export async function getServerSideProps() {
  return {
    props: {
      timestamp: new Date().toISOString(),
      message: "Hello from getServerSideProps",
    },
  };
}
