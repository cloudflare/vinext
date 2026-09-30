import Router from "next/router";

export default function LegacyPage() {
  return (
    <main>
      <h1 id="legacy">Legacy page</h1>
      <button id="push-other" onClick={() => void Router.push("/other")} type="button">
        Push to other
      </button>
    </main>
  );
}
