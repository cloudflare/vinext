import Comment from 'components/comment';
import getItem from 'lib/get-item'
import getComments from 'lib/get-comments';
import styles from './page.module.css';

export default async function Comments({ params }) {
  const { id } = await params
  const story = await getItem(id)
  const comments = await getComments(story.comments);
  return (
    <div className={styles.comments}>
      {(comments || []).map((comment) => (
        <Comment key={comment.id} {...comment} />
      ))}
    </div>
  );
}
