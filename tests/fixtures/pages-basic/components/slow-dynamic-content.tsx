import React from "react";

export default function SlowDynamicContent({ label }: { label: string }) {
  return (
    <div className="slow-dynamic-content">
      <p>{label}</p>
    </div>
  );
}
