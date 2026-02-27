import styles from './header.module.css'
import Link from 'next/link'

const navItems = [
  { title: 'new' },
  { title: 'past' },
  { title: 'show' },
  { title: 'ask' },
  { title: 'show' },
  { title: 'jobs' },
  { title: 'submit' }
]

export default function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <Link href="/">
          <span className={styles.logo}>
            <span className={styles.n}>N</span>
          </span>
          <span className={styles['site-title']}>Hacker Next</span>
        </Link>
        <div className={styles.nav}>
          <ul className={styles['nav-ul']}>
            {navItems.map(({ title }, index) => (
              <li key={index}>
                <span>{title}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className={styles.right}>
        <span className={styles.login}>
          login
        </span>
      </div>
    </header>
  )
}
