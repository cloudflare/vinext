import { Suspense } from "react";

let result: string | undefined;
let promise: Promise<void> | undefined;

function Data() {
  if (result) return result;
  promise ??= new Promise<void>((resolve) => {
    setTimeout(() => {
      result = "next_streaming_data";
      resolve();
    }, 500);
  });
  throw promise;
}

export default function StreamingHydrationPage() {
  return (
    <Suspense fallback="next_streaming_fallback">
      <Data />
    </Suspense>
  );
}
