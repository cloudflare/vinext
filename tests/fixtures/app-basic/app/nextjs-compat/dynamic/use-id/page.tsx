"use client";

// A Client Component call site: the server renders dynamic() with its own
// element shape and the browser hydrates it with the client one, so useId
// values inside the dynamic component only match if those shapes agree.
import dynamic from "next/dynamic";

const UseIdField = dynamic(() => import("./use-id-field"));

export default function DynamicUseIdPage() {
  return (
    <div>
      Index
      <UseIdField />
    </div>
  );
}
