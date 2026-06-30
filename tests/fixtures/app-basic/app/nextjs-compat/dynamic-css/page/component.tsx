import "./global.css";
import "./query.css";
import "./template.css";
import base from "./base.module.css";
import styles from "./component.module.css";

export default function Component() {
  return (
    <p
      id="dynamic-css-component"
      className={`dynamic-css-global dynamic-css-query dynamic-css-template ${base.class} ${styles.class}`}
    >
      Hello Component
    </p>
  );
}
