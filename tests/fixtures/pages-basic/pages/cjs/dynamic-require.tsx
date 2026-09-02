const locale = "ru";
const messages = require(`../../locales/${locale}`);

export default function DynamicRequirePage() {
  return <p data-testid="dynamic-require-message">{messages ? "loaded" : "missing"}</p>;
}
