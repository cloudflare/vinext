// Another route under the async layout, so the layout's client component,
// which both routes render, gets a client chunk and stylesheet of its own,
// apart from the page's.
export default function Page() {
  return <p>Other</p>;
}
