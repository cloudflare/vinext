import { Counter } from "../nested/[section]/counter";

export default function TemplateSeedTemplate({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <Counter id="template-seed" label="Template counter" />
      {children}
    </div>
  );
}
