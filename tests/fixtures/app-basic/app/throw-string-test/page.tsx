export default function ThrowStringTestPage() {
  throw "this is a test string thrown in a server component";
  return <div>This should never render</div>;
}
