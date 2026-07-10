type FlightFramingState = typeof globalThis & {
  __flightFramingEntries?: string[];
};

export const revalidate = 60;

export default function StoredPage() {
  const entries = (globalThis as FlightFramingState).__flightFramingEntries ?? [];
  return (
    <main>
      {entries.map((entry, index) => (
        <p key={index}>{entry}</p>
      ))}
    </main>
  );
}
