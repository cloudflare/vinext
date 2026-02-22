import styles from './comment-form.module.css';

export default () => (
  <div>
    <textarea className={styles.textarea} />
    <button className={styles.button}>add comment</button>
  </div>
);
