---
title: "静态博客部署检查清单"
date: 2026-04-30
description: "把 Astro 静态博客部署到服务器前，可以按这个清单快速检查构建、资源和站点地址。"
category: "运维"
tags: ["部署", "Astro", "运维"]
pinned: false
pinOrder: 0
---

## 构建是否通过

部署前先跑一次构建，这是最基础也最有效的检查。

```powershell
npm.cmd run build
```

如果构建失败，先处理内容字段、路由和资源路径问题。

## 资源路径

静态资源最好放在 `public` 目录下，然后用以 `/` 开头的路径引用。

例如：

```html
<img src="/assets/home-bg.jpg" alt="背景图" />
```

## 站点地址

RSS、Sitemap 和 Open Graph 都依赖站点地址。上线前要确认 `astro.config.mjs` 里的 `site` 是正式域名。

## 缓存

图片、字体和 CSS 都可以长期缓存，但 HTML 最好保守一点。这样更新文章时，读者不会一直看到旧页面。
