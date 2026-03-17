/**
 * Shared component that renders each param as a div with a predictable ID.
 * Used by layout-params tests to verify which params each layout receives.
 */
export default function ShowParams({
  prefix,
  params,
}: {
  prefix: string;
  params: Record<string, unknown>;
}) {
  return (
    <div id={`${prefix}-layout`}>
      {Object.entries(params).map(([key, val]) => (
        <div key={key} id={`${prefix}-${key}`}>
          {JSON.stringify(val)}
        </div>
      ))}
    </div>
  );
}
