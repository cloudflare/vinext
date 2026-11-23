// A small helper that the card sections call, and two pages call themselves.
export function cardTitle(value: string): string {
  return `marker-card-title:${value.trim()}`;
}
