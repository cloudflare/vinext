import { readRequires } from "esm-require-dependency";

export const dynamic = "force-dynamic";

export default function EsmDependencyRequirePage() {
  const result = readRequires();
  return (
    <dl>
      {Object.entries(result).map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd id={name}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
