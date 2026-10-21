"use client";

// Only the archived view renders this client module, so a navigation to it
// has to load the module after the response arrives.
export function ArchivedItems() {
  return (
    <p data-testid="search-transition-archived-items" id="archived-items">
      Archived items
    </p>
  );
}
