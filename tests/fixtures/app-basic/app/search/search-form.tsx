"use client";

import Form from "next/form";

export default function SearchForm() {
  return (
    <Form action="/search" id="search-form">
      <input name="q" placeholder="Search..." id="search-input" />
      <button type="submit" id="search-button">
        Search
      </button>
    </Form>
  );
}
