export default function ThrowingPage() {
  return <h1>Unreachable</h1>;
}

export function getServerSideProps(): never {
  throw new Error("Pages ISR query context fixture error");
}
