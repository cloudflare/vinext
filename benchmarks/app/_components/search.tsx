"use client";
import { useState } from "react";

export function Search({ placeholder = "Search..." }: { placeholder?: string }) {
  const [query, setQuery] = useState("");
  return (
    <div style={{ marginBottom: "1rem" }}>
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={placeholder}
        style={{ padding: "0.5rem", border: "1px solid #ddd", borderRadius: "4px", width: "300px" }}
      />
      {query && <p style={{ fontSize: "0.8rem", color: "#666" }}>Searching for: {query}</p>}
    </div>
  );
}

