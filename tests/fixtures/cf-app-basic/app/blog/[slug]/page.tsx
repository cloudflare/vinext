export function generateStaticParams() {
  return [{ slug: "hello-world" }, { slug: "getting-started" }];
}

export default function BlogPost() {
  return <h1>Blog post</h1>;
}
