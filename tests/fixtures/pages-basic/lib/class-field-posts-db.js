// Server-only: only getServerSideProps in pages/class-field-gssp.jsx reaches
// this module, so the client build must not evaluate it.
class PostsClient {
  constructor(url) {
    this.url = url;
  }

  async query() {
    return [{ id: 1, title: "First post" }];
  }
}

const client = new PostsClient("postgres://class-field-gssp-server-only.internal/posts");
globalThis.__classFieldPostsClient = client;

export function query(sql) {
  return client.query(sql);
}
