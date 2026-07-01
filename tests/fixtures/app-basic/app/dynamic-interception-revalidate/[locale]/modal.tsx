"use client";

import { useState } from "react";
import { revalidateInterceptedPhoto } from "./actions";

export function RevalidateModal({ photoId }: { photoId: string }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<number>();

  async function handleClick() {
    setLoading(true);
    const nextResult = await revalidateInterceptedPhoto();
    setLoading(false);
    setResult(nextResult);
  }

  return (
    <>
      <h2>Photo Id: {photoId}</h2>
      <button id="dynamic-interception-revalidate-button" onClick={handleClick}>
        Revalidate
      </button>
      {loading ? <div id="dynamic-interception-revalidate-loading">Loading...</div> : null}
      {result !== undefined ? (
        <div id="dynamic-interception-revalidate-result">Result: {result}</div>
      ) : null}
    </>
  );
}
