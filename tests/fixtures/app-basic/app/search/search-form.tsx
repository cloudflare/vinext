"use client";

import Form from "next/form";

export default function SearchForm() {
  return (
    <>
      <Form action="/search" id="search-form">
        <input name="q" placeholder="Search..." id="search-input" />
        <button type="submit" id="search-button">
          Search
        </button>
      </Form>

      <Form action="/search" id="search-form-with-hidden-lang">
        <input type="hidden" name="lang" value="en" />
        <input name="q" placeholder="Search with locale..." id="search-input-with-query" />
        <button type="submit" id="search-button-with-query">
          Search With Hidden Lang
        </button>
      </Form>

      <Form action="/search" id="search-form-with-submitter-action">
        <input type="hidden" name="lang" value="fr" />
        <input
          name="q"
          placeholder="Search with submitter action..."
          id="search-input-with-submitter-action"
        />
        <button
          type="submit"
          id="search-button-with-submitter-action"
          formAction="/search-alt"
          name="source"
          value="submitter-action"
        >
          Search With Submitter Action
        </button>
      </Form>

      <Form action="/search" method="POST" id="search-form-post-with-get-submitter">
        <input type="hidden" name="lang" value="de" />
        <input
          name="q"
          placeholder="Search with submitter method..."
          id="search-input-post-with-get-submitter"
        />
        <button
          type="submit"
          id="search-button-post-with-get-submitter"
          formAction="/search-alt"
          formMethod="GET"
          name="source"
          value="submitter-method"
        >
          Search With Submitter Method
        </button>
      </Form>
    </>
  );
}
