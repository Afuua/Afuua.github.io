---
title: "Astro 内容写作流程"
date: 2026-05-18
description: "用 Astro Content Collections 管理 Markdown 文章，让博客内容和页面结构保持清爽。"
category: "前端"
tags: ["Astro", "Markdown", "前端"]
pinned: true
pinOrder: 10
---

## 内容即文件

Astro 很适合做个人博客，其中一个原因是 Markdown 文件天然就是内容数据库。

每篇文章放在 `src/content/posts` 下，通过 frontmatter 描述标题、日期、摘要和标签，页面侧只负责渲染。

## 字段约束

内容集合可以定义 schema。这样写文章时，如果漏掉标题或日期，构建阶段就能提前发现。

```ts
const posts = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    date: z.date(),
    description: z.string(),
  }),
});
```

## 写作节奏

我更喜欢先写粗糙版本，然后在发布前补摘要、标签和代码示例。

这套流程的好处是不用打开后台，不用维护数据库，换电脑也只需要同步仓库。

## 小结

当博客规模还不大时，Markdown 文件是非常舒服的选择。它简单、透明，也足够耐用。
