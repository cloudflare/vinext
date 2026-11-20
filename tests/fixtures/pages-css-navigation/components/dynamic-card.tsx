import styles from "./dynamic-card.module.css";

export default function DynamicCard() {
  return (
    <p data-probe="card" className={`app-text ${styles.card}`}>
      Dynamic card
    </p>
  );
}
