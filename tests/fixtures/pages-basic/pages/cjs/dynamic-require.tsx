const locale = "ru";
const messages = require(`../../locales/${locale}`).default;

export default function DynamicRequirePage() {
  return <p data-testid="dynamic-require-message">{messages.message}</p>;
}
