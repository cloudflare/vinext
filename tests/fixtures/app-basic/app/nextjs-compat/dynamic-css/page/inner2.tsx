"use client";

import base from "./base.module.css";
import styles from "./inner2.module.css";

export default function Inner2() {
  if (typeof window === "undefined") {
    throw new Error("Expected error to opt out of server rendering");
  }

  return (
    <p id="dynamic-css-inner2" className={`dynamic-css-global ${base.class} ${styles.class}`}>
      Hello Inner 2
    </p>
  );
}
