const formatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** Ledger and inventory share this formatter. */
export const formatCents = (cents: number): string => formatter.format(cents / 100);
