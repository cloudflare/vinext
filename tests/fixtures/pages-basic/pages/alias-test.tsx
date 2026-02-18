import HeavyComponent from "@/components/heavy";

export default function AliasTestPage() {
  return (
    <div>
      <h1>Pages Alias Test</h1>
      <p>This page imports a component via tsconfig path alias @/</p>
      <HeavyComponent label="Loaded via alias" />
    </div>
  );
}
