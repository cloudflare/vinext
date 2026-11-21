import { Component } from "react";
import { query } from "../lib/class-field-posts-db";

async function getPosts() {
  return query("select id, title from posts");
}

export async function getServerSideProps() {
  return { props: { posts: await getPosts() } };
}

// The `getPosts` field shares its name with the server-only helper above.
export default class ClassFieldPostsPage extends Component {
  getPosts = () => this.props.posts;

  render() {
    return (
      <ul id="class-field-posts">
        {this.getPosts().map((post) => (
          <li key={post.id}>{post.title}</li>
        ))}
      </ul>
    );
  }
}
