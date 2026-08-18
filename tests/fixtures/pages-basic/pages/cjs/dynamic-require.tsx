const locale = "ru";
const messages = require(`../../locales/${locale}.js`);

export default function DynamicRequirePage() {
  return <p data-testid="dynamic-require-message">{messages ? "loaded" : "missing"}</p>;
}
