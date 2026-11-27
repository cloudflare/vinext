// Only the intercepted render (a soft navigation from /feed) is force-dynamic.
export const dynamic = "force-dynamic";

export default function InterceptedPhoto() {
  return <p>intercepted photo</p>;
}
