import React from "react";

export default function HeavyComponent({ label }: { label?: string }) {
  return (
    <div className="heavy-component">
      <h2>Heavy Component</h2>
      <p>{label ?? "I was dynamically imported!"}</p>
    </div>
  );
}
