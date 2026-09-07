import styles from "./early.module.css";
import "./late.css";

export default function ReverseOrderPage() {
  return (
    <p id="reverse-order" className={`${styles.class} reverse-order`}>
      Later global styles win
    </p>
  );
}
