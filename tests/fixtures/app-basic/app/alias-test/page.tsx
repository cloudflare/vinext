import Counter from "@/app/components/counter";
import ClientOnlyWidget from "@/app/components/client-only-widget";

export default function AliasTestPage() {
  return (
    <div>
      <h1>Alias Test</h1>
      <p>This page imports components via tsconfig path alias @/</p>
      <Counter />
      <ClientOnlyWidget />
    </div>
  );
}
