export default function ImportMetaPage() {
  const data = {
    url: import.meta.url,
  };

  return <div id="test-data">{JSON.stringify(data)}</div>;
}
