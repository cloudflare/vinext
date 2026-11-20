import { useLayoutEffect, useRef } from "react";
import { panelText } from "../components/panel";
import styles from "../styles/beta.module.css";

export default function Beta() {
  const text = useRef<HTMLParagraphElement>(null);
  // Next.js turns the page's stylesheets on before its layout effects run.
  useLayoutEffect(() => {
    document.body.dataset.layoutColor = getComputedStyle(text.current!).color;
  }, []);
  return (
    <p
      ref={text}
      data-page="beta"
      data-probe="text"
      className={`app-text ${panelText} ${styles.text}`}
    >
      Beta
    </p>
  );
}
