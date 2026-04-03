'use client';

import { useState } from 'react';

import timeAgo from '../lib/time-ago';

import styles from './comment.module.css';

export default function Comment({ user, text, date, comments, commentsCount }) {
  const [toggled, setToggled] = useState(false);

  const toggle = () => setToggled(!toggled);

  return (
    <div className={styles.comment}>
      <div className={styles.meta} suppressHydrationWarning>
        {user} {timeAgo(new Date(date))} ago{' '}
        <span onClick={toggle} className={styles.toggle}>
          {toggled ? `[+${(commentsCount || 0) + 1}]` : '[-]'}
        </span>
      </div>

      {toggled
        ? null
        : [
            <div
              key="text"
              className={styles.text}
              dangerouslySetInnerHTML={{ __html: text }}
            />,
            <div key="children" className={styles.children}>
              {comments.map((comment) => (
                <Comment key={comment.id} {...comment} />
              ))}
            </div>,
          ]}
    </div>
  );
}
