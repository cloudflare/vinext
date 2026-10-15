"use client";

export function SearchParamsLabel({ searchParams }: { searchParams: Promise<unknown> }) {
  return <p data-testid="search-params-label">{typeof searchParams}</p>;
}
