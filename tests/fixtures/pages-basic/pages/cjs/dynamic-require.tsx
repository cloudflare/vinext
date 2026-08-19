let extraArgumentEvaluated = false;
const messages =
  require(`../../locales/${require("../../locale-name")}`, (extraArgumentEvaluated = true)).default;

export default function DynamicRequirePage() {
  return (
    <p data-testid="dynamic-require-message">
      {messages.message}|extra:{String(extraArgumentEvaluated)}
    </p>
  );
}
