import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const posts = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: "./versions/current/posts",
  }),
  schema: z.object({
    title: z.string(),
    date: z.date(),
    description: z.string(),
    category: z.string().default("未分类"),
    tags: z.array(z.string()).default([]),
    pinned: z.boolean().default(false),
    pinOrder: z.number().default(0),
    draft: z.boolean().default(false),
    cover: z.string().optional(),
  }),
});

export const collections = { posts };
