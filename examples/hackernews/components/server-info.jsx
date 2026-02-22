import styles from './server-info.module.css';

export default function ServerInfo() {
  return (
    <div className={styles['server-info']}>
      Rendered at {new Date().toTimeString()} with Cloudflare Workers.
    </div>
  );
}
