import type { ReactNode } from "react";
import styles from "./tag.module.css";

// A small component with a CSS module that both panels use. Each panel passes
// a class of its own to recolour the border.
export function Tag({
  children,
  className,
  probe,
}: {
  children: ReactNode;
  className: string;
  probe: string;
}) {
  return (
    <span className={`${styles.tag} ${className}`} data-probe={probe}>
      {children}
    </span>
  );
}
