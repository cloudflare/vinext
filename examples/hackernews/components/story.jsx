'use client'

import { useState } from 'react'
import Link from 'next/link'
import timeAgo from '../lib/time-ago'
import styles from './story.module.css'

export default function Story({
  id,
  title,
  date,
  url,
  user,
  score,
  commentsCount
}) {
  const { host } = url ? new URL(url) : { host: '#' }
  const [voted, setVoted] = useState(false)

  return (
    <div className={styles.story}>
      <div className={styles.title}>
        <span
          className={voted ? styles['votearrow--voted'] : styles.votearrow}
          onClick={() => setVoted(!voted)}
        >
          &#9650;
        </span>
        <a href={url} rel="noopener noreferrer nofollow" target="_blank">{title}</a>
        {url && (
          <span className={styles.source}>
            {' ('}
            <a href={`http://${host}`} rel="noopener noreferrer nofollow" target="_blank">{host.replace(/^www\./, '')}</a>
            {')'}
          </span>
        )}
      </div>
      <div className={styles.meta}>
        {score} {plural(score, 'point')} by{' '}
        <span>{user}</span>{' '}
        <Link href={`/item/${id}`}>
          <span suppressHydrationWarning>
            {timeAgo(new Date(date))} ago
          </span>
        </Link>{' '}
        |{' '}
        <Link href={`/item/${id}`}>
          {commentsCount} {plural(commentsCount, 'comment')}
        </Link>
      </div>
    </div>
  )
}

const plural = (n, s) => s + (n === 0 || n > 1 ? 's' : '')
