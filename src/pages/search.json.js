import { getCollection } from "astro:content";
import { sortPosts } from "../utils/posts";

export async function GET() {
  const posts = sortPosts(await getCollection("posts", ({ data }) => !data.draft));
  return new Response(
    JSON.stringify(
      posts.map((post) => ({
        id: post.id,
        title: post.data.title,
        description: post.data.description,
        category: post.data.category || "未分类",
        tags: post.data.tags,
        date: post.data.date.toISOString(),
        pinned: post.data.pinned,
      }))
    ),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    }
  );
}
