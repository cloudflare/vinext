import { useState } from "react";
import { readSourcemapData } from "../../lib/sourcemap-data-source";

// Only the data export calls this; its type reference below is erased.
function loadSourcemapData(): string {
  return `SOURCEMAP_SERVER_HELPER ${readSourcemapData()}`;
}
type LoadSourcemapData = typeof loadSourcemapData;

export default function ServerPropsPage({ value }: { value: string }) {
  const [clicks, setClicks] = useState(0);
  return (
    <button id="sourcemap-data-button" onClick={() => setClicks(clicks + 1)}>
      SOURCEMAP_CLIENT_COMPONENT {value} {clicks}
    </button>
  );
}

export async function getServerSideProps() {
  const load: LoadSourcemapData = loadSourcemapData;
  return { props: { value: `SOURCEMAP_SERVER_PROPS ${load().length}` } };
}
