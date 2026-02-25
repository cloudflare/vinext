import Link from 'next/link'
import Story from './story'

import fetchData from '../lib/fetch-data'
import { transform } from '../lib/get-item'

import styles from './stories.module.css'

async function StoryWithData({ id }) {
  const data = await fetchData(`item/${id}`)
  const story = transform(data)

  return <Story {...story} />
}

export default async function Stories({ storyIds, page = 1 }) {
  const limit = 30
  const offset = (page - 1) * limit

  return (
    <div>
      {storyIds.slice(offset, offset + limit).map((id, i) => (
        <div key={id} className={styles.item}>
          {null != offset ? (
            <span className={styles.count}>{i + offset + 1}</span>
          ) : null}
          <StoryWithData id={id} key={id} />
        </div>
      ))}
      <div className={styles.footer}>
        <Link href={`/news/${+page + 1}`}>More</Link>
      </div>
    </div>
  )
}
