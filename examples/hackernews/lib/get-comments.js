import sanitizeHtml from 'sanitize-html'
import fetchData from './fetch-data'

// hydrate comments based on an array of item ids
export default function fetch(ids) {
  return Promise.all(
    ids.map(async (id) => {
      const val = await fetchData(`item/${id}`)
      return {
        id: val.id,
        user: val.by,
        // HN API returns comment text as HTML. Sanitize at the data boundary
        // so both the SSR'd initial response and client re-renders are safe.
        // sanitize-html is pure-JS and works in both Node.js and Workers.
        text: sanitizeHtml(val.text ?? ''),
        date: new Date(val.time * 1000).getTime() || 0,
        comments: await fetch(val.kids || []),
        commentsCount: val.descendants || 0,
      }
    })
  )
}
