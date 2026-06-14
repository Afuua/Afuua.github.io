import type { CollectionEntry } from "astro:content";

export const POSTS_PER_PAGE = 9;

export type BlogPost = CollectionEntry<"posts">;

export function isPublished(post: BlogPost) {
  return !post.data.draft;
}

export function sortPosts(posts: BlogPost[]) {
  return [...posts].sort((a, b) => {
    if (a.data.pinned !== b.data.pinned) return a.data.pinned ? -1 : 1;
    if (a.data.pinned && b.data.pinned && a.data.pinOrder !== b.data.pinOrder) {
      return b.data.pinOrder - a.data.pinOrder;
    }
    return b.data.date.getTime() - a.data.date.getTime();
  });
}

export function paginatePosts(posts: BlogPost[], page: number, perPage = POSTS_PER_PAGE) {
  const totalPages = Math.max(1, Math.ceil(posts.length / perPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * perPage;

  return {
    currentPage,
    totalPages,
    posts: posts.slice(start, start + perPage),
  };
}

export function getAllTags(posts: BlogPost[]) {
  const count = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) count.set(tag, (count.get(tag) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"));
}

export function getAllCategories(posts: BlogPost[]) {
  const count = new Map<string, number>();
  for (const post of posts) {
    const category = post.data.category || "未分类";
    count.set(category, (count.get(category) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"));
}

export function getRelatedPosts(posts: BlogPost[], current: BlogPost, limit = 3) {
  return sortPosts(posts)
    .filter((post) => post.id !== current.id)
    .map((post) => {
      const sameCategory = post.data.category === current.data.category ? 4 : 0;
      const sharedTags = post.data.tags.filter((tag) => current.data.tags.includes(tag)).length;
      return { post, score: sameCategory + sharedTags };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.post.data.date.getTime() - a.post.data.date.getTime())
    .slice(0, limit)
    .map((item) => item.post);
}
