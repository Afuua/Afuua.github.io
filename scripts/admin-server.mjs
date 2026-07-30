import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, readdir, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import {
  createSnapshot,
  currentBackgroundPath,
  currentPostsDir,
  ensureVersionStructure,
  rootDir,
  syncPublicAssets,
} from "./version-store.mjs";

const postsDir = currentPostsDir;
const backgroundPath = currentBackgroundPath;
const coversDir = resolve(rootDir, "public", "assets", "covers");

const host = "127.0.0.1";
const port = Number(process.env.ADMIN_PORT || 8787);
const adminUser = process.env.ADMIN_USER || "afu";
const adminPassword = process.env.ADMIN_PASSWORD || "afu-admin";
const adminBasePath = normalizeBasePath(process.env.ADMIN_BASE_PATH || "");
const adminBaseHref = adminBasePath ? `${adminBasePath}/` : "/";
const sitePublicUrl = process.env.SITE_PUBLIC_URL || "/";
const autoBuild = process.env.ADMIN_AUTO_BUILD === "true";
let buildInProgress = false;

function normalizeBasePath(value) {
  const clean = String(value || "").trim().replace(/\/+$/g, "");
  if (!clean || clean === "/") return "";
  return clean.startsWith("/") ? clean : `/${clean}`;
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isAuthorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const splitAt = decoded.indexOf(":");
  if (splitAt === -1) return false;
  const user = decoded.slice(0, splitAt);
  const password = decoded.slice(splitAt + 1);
  return safeEqual(user, adminUser) && safeEqual(password, adminPassword);
}

function requireAuth(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Afu Blog Admin"',
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("Authentication required.");
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function sendBytes(res, bytes, contentType) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(bytes);
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  return text ? JSON.parse(text) : {};
}

function postPathFromSlug(slug) {
  const cleanSlug = String(slug || "").trim();
  if (!cleanSlug || cleanSlug.includes("..") || /[<>:"/\\|?*\x00-\x1F]/.test(cleanSlug)) {
    throw new Error("Invalid slug.");
  }
  const fullPath = resolve(postsDir, `${cleanSlug}.md`);
  if (!fullPath.startsWith(`${postsDir}${sep}`)) throw new Error("Invalid post path.");
  return fullPath;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parsePostMarkdown(markdown, slug) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const data = {
    title: slug,
    date: new Date().toISOString().slice(0, 10),
    description: "",
    category: "未分类",
    tags: [],
    pinned: false,
    pinOrder: 0,
    draft: false,
  };
  let content = markdown;

  if (match) {
    content = match[2] || "";
    for (const line of match[1].split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index === -1) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1);
      data[key] = parseScalar(value);
    }
  }

  if (!Array.isArray(data.tags)) data.tags = [];
  data.category = String(data.category || "未分类").trim() || "未分类";
  data.pinned = Boolean(data.pinned);
  data.pinOrder = Number(data.pinOrder || 0);
  return { slug, ...data, content };
}

async function loadPost(slug) {
  await ensureVersionStructure();
  const filePath = postPathFromSlug(slug);
  const markdown = await readFile(filePath, "utf8");
  const fileStat = await stat(filePath);
  return {
    ...parsePostMarkdown(markdown, slug),
    updatedAt: fileStat.mtime.toISOString(),
  };
}

function formatPostMarkdown(post) {
  const tags = Array.isArray(post.tags)
    ? post.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : [];
  const draft = Boolean(post.draft);
  const category = String(post.category || "未分类").trim() || "未分类";
  const pinned = Boolean(post.pinned);
  const pinOrder = Number(post.pinOrder || 0);
  const content = String(post.content || "").replace(/^\uFEFF/, "").trimStart();

  return `---\ntitle: ${JSON.stringify(String(post.title || "未命名文章"))}\ndate: ${String(
    post.date || new Date().toISOString().slice(0, 10)
  )}\ndescription: ${JSON.stringify(String(post.description || ""))}\ncategory: ${JSON.stringify(
    category
  )}\ntags: ${JSON.stringify(
    tags
  )}\ncover: ${JSON.stringify(String(post.cover || "").trim())}\npinned: ${pinned}\npinOrder: ${pinOrder}\ndraft: ${draft}\n---\n\n${content}`;
}

async function listPosts() {
  await ensureVersionStructure();
  const files = await readdir(postsDir);
  const posts = [];
  for (const file of files.filter((name) => extname(name) === ".md")) {
    const slug = file.slice(0, -3);
    try {
      const post = await loadPost(slug);
      posts.push({
        slug,
        title: post.title,
        date: post.date,
        description: post.description,
        category: post.category,
        tags: post.tags,
        pinned: post.pinned,
        pinOrder: post.pinOrder,
        draft: post.draft,
        updatedAt: post.updatedAt,
      });
    } catch (error) {
      posts.push({
        slug,
        title: slug,
        date: "",
        description: String(error),
        category: "未分类",
        tags: [],
        pinned: false,
        pinOrder: 0,
        draft: true,
      });
    }
  }
  posts.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned && a.pinOrder !== b.pinOrder) return b.pinOrder - a.pinOrder;
    return String(b.date).localeCompare(String(a.date));
  });
  return posts;
}

function decodeSlugFromPath(pathname) {
  const prefix = "/api/posts/";
  return decodeURIComponent(pathname.slice(prefix.length));
}

async function savePost(slug, payload) {
  await ensureVersionStructure();
  await createSnapshot(`save-post:${slug}`);
  const filePath = postPathFromSlug(slug);
  await writeFile(filePath, formatPostMarkdown(payload), "utf8");
  return loadPost(slug);
}

async function saveBackground(dataUrl) {
  await ensureVersionStructure();
  const match = String(dataUrl || "").match(/^data:image\/jpeg;base64,([\s\S]+)$/);
  if (!match) throw new Error("Only JPEG images are supported for home-bg.jpg.");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Image must be smaller than 8MB.");
  await createSnapshot("update-background");
  await writeFile(backgroundPath, bytes);
  await syncPublicAssets();
  return { ok: true, size: bytes.length, updatedAt: new Date().toISOString() };
}

function runBuild() {
  if (buildInProgress) throw new Error("Build is already running.");
  buildInProgress = true;

  return new Promise((resolveBuild, rejectBuild) => {
    const startedAt = Date.now();
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    let child;
    let output = "";
    const finish = (callback, value) => {
      buildInProgress = false;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      child?.kill();
      finish(rejectBuild, new Error("Build timed out after 120 seconds."));
    }, 120000);

    try {
      child = spawn(command, ["run", "build"], {
        cwd: rootDir,
        shell: process.platform === "win32",
        env: process.env,
      });
    } catch (error) {
      buildInProgress = false;
      clearTimeout(timeout);
      rejectBuild(error);
      return;
    }

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => finish(rejectBuild, error));
    child.on("close", (code) => {
      const result = {
        ok: code === 0,
        code,
        durationMs: Date.now() - startedAt,
        output: output.slice(-6000),
      };
      if (code === 0) finish(resolveBuild, result);
      else finish(rejectBuild, new Error(`Build failed with exit code ${code}.\n${result.output}`));
    });
  });
}

async function maybeBuild() {
  if (!autoBuild) return null;
  return runBuild();
}

function stripBasePath(pathname) {
  if (!adminBasePath) return pathname;
  if (pathname === adminBasePath) return "/";
  if (pathname.startsWith(`${adminBasePath}/`)) return pathname.slice(adminBasePath.length) || "/";
  return pathname;
}

function renderAdminPage() {
  return adminPage
    .replaceAll("__ADMIN_BASE_HREF__", adminBaseHref)
    .replaceAll("__SITE_PUBLIC_URL__", sitePublicUrl);
}

const adminPage = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <base href="__ADMIN_BASE_HREF__" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Afu Blog Admin</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #eef4f8;
        --panel: rgba(255,255,255,.92);
        --line: rgba(72,91,117,.16);
        --text: #1f2a37;
        --muted: #6b7280;
        --primary: #176bb7;
        --accent: #28b8a8;
        --danger: #dc2626;
        --shadow: 0 18px 46px rgba(44,62,80,.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-width: 1100px;
        color: var(--text);
        font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
        background:
          radial-gradient(circle at 8% 12%, rgba(40,184,168,.16), transparent 24rem),
          radial-gradient(circle at 90% 5%, rgba(58,141,222,.16), transparent 24rem),
          linear-gradient(180deg, var(--bg), #f8fbfd);
      }
      button, input, textarea { font: inherit; }
      button {
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 9px 13px;
        color: var(--text);
        background: #fff;
        cursor: pointer;
      }
      button:hover { border-color: rgba(23,107,183,.35); color: var(--primary); }
      button.primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, var(--primary), var(--accent)); }
      button.danger { color: var(--danger); }
      input, textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px 12px;
        color: var(--text);
        background: rgba(255,255,255,.88);
        outline: none;
      }
      input:focus, textarea:focus { border-color: rgba(23,107,183,.45); box-shadow: 0 0 0 3px rgba(58,141,222,.12); }
      textarea {
        min-height: calc(100vh - 410px);
        resize: vertical;
        line-height: 1.7;
        font-family: Consolas, "Microsoft YaHei", monospace;
      }
      header {
        position: sticky;
        top: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 64px;
        padding: 0 24px;
        border-bottom: 1px solid var(--line);
        background: rgba(255,255,255,.78);
        backdrop-filter: blur(14px);
      }
      h1 { margin: 0; font-size: 20px; }
      main {
        display: grid;
        grid-template-columns: 320px minmax(0, 1fr);
        gap: 22px;
        padding: 22px;
      }
      .panel {
        border: 1px solid var(--line);
        border-radius: 16px;
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(16px);
      }
      .sidebar { overflow: hidden; }
      .sidebar-head {
        display: flex;
        gap: 10px;
        padding: 14px;
        border-bottom: 1px solid var(--line);
      }
      .post-list {
        max-height: calc(100vh - 180px);
        overflow: auto;
        padding: 8px;
      }
      .post-item {
        display: grid;
        gap: 5px;
        width: 100%;
        margin-bottom: 8px;
        padding: 12px;
        border: 1px solid transparent;
        border-radius: 12px;
        text-align: left;
        background: transparent;
      }
      .post-item.active, .post-item:hover {
        border-color: rgba(58,141,222,.24);
        background: rgba(58,141,222,.08);
      }
      .post-title { font-weight: 700; }
      .post-meta { color: var(--muted); font-size: 12px; }
      .editor { padding: 18px; }
      .editor-grid {
        display: grid;
        grid-template-columns: 1fr 170px;
        gap: 14px;
      }
      .editor-grid.three {
        grid-template-columns: 1fr 150px 150px;
      }
      .field { display: grid; gap: 7px; margin-bottom: 14px; }
      .checkbox-field {
        align-content: end;
      }
      .checkbox-row {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 42px;
      }
      label { color: var(--muted); font-size: 13px; }
      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 16px;
      }
      .actions { display: flex; gap: 10px; }
      .status {
        min-height: 20px;
        color: var(--muted);
        font-size: 13px;
      }
      .background-box {
        display: grid;
        grid-template-columns: 220px 1fr;
        gap: 16px;
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px solid var(--line);
      }
      .background-box img {
        width: 220px;
        aspect-ratio: 16 / 9;
        border-radius: 12px;
        object-fit: cover;
        box-shadow: 0 10px 26px rgba(44,62,80,.12);
      }
      .hint { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.7; }
    </style>
  </head>
  <body>
    <header>
      <h1>Afu Blog Admin</h1>
      <div class="actions">
        <button id="refresh">刷新文章</button>
        <button id="newPost" class="primary">新建文章</button>
        <button id="buildSite">重新构建</button>
        <a href="__SITE_PUBLIC_URL__" target="_blank" rel="noreferrer"><button>打开博客</button></a>
      </div>
    </header>

    <main>
      <aside class="panel sidebar">
        <div class="sidebar-head">
          <input id="search" placeholder="搜索标题 / 分类 / 标签" />
        </div>
        <div id="postList" class="post-list"></div>
      </aside>

      <section class="panel editor">
        <div class="toolbar">
          <div>
            <strong id="editorTitle">文章编辑</strong>
            <div id="status" class="status"></div>
          </div>
          <div class="actions">
            <button id="deletePost" class="danger">删除</button>
            <button id="savePost" class="primary">保存文章</button>
          </div>
        </div>

        <div class="editor-grid">
          <div class="field">
            <label for="title">标题</label>
            <input id="title" />
          </div>
          <div class="field">
            <label for="date">日期</label>
            <input id="date" type="date" />
          </div>
        </div>
        <div class="editor-grid">
          <div class="field">
            <label for="slug">Slug / 文件名</label>
            <input id="slug" placeholder="my-new-post" />
          </div>
          <div class="field checkbox-field">
            <label for="draft">草稿</label>
            <span class="checkbox-row"><input id="draft" type="checkbox" style="width:auto" />草稿</span>
          </div>
        </div>
        <div class="editor-grid three">
          <div class="field">
            <label for="category">分类</label>
            <input id="category" placeholder="前端" />
          </div>
          <div class="field checkbox-field">
            <label for="pinned">置顶</label>
            <span class="checkbox-row"><input id="pinned" type="checkbox" style="width:auto" />置顶</span>
          </div>
          <div class="field">
            <label for="pinOrder">置顶权重</label>
            <input id="pinOrder" type="number" value="0" />
          </div>
        </div>
        <div class="field">
          <label for="description">摘要</label>
          <input id="description" />
        </div>
        <div class="editor-grid">
          <div class="field">
            <label for="coverSelect">封面图</label>
            <div class="background-box" style="border-top:none;margin-top:0;padding-top:0">
              <img id="coverPreview" src="assets/home-bg.jpg" alt="封面预览" />
              <div>
                <select id="coverSelect" style="width:100%;margin-bottom:8px"><option value="">默认封面</option></select>
                <input id="coverFile" type="file" accept="image/jpeg,image/png,image/webp" />
                <button id="uploadCover" class="primary" style="margin-top:6px">上传</button>
              </div>
            </div>
          </div>
        </div>
        <div class="field">
          <label for="tags">标签，使用逗号分隔</label>
          <input id="tags" placeholder="前端, Astro, 随笔" />
        </div>
        <div class="field">
          <label for="content">Markdown 正文</label>
          <textarea id="content" spellcheck="false"></textarea>
        </div>

        <section class="background-box">
          <img id="bgPreview" src="assets/home-bg.jpg" alt="首页背景预览" />
          <div>
            <strong>首页背景图</strong>
            <p class="hint">上传会更新 <code>versions/current/assets/home-bg.jpg</code>，并在写入前自动创建快照。当前版本只接受 JPEG，建议尺寸 1920x1080 或更高。</p>
            <div class="actions" style="margin-top:12px">
              <input id="bgFile" type="file" accept="image/jpeg" />
              <button id="uploadBg" class="primary">上传背景</button>
            </div>
          </div>
        </section>
      </section>
    </main>

    <script>
      const state = { posts: [], currentSlug: "" };
      const $ = (id) => document.getElementById(id);

      function setStatus(text, isError = false) {
        $("status").textContent = text;
        $("status").style.color = isError ? "var(--danger)" : "var(--muted)";
      }

      async function api(path, options = {}) {
        const res = await fetch(path, {
          ...options,
          headers: {
            "Content-Type": "application/json",
            ...(options.headers || {}),
          },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Request failed");
        return data;
      }

      function slugify(value) {
        return String(value || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
          .replace(/^-+|-+$/g, "");
      }

      function formToPost() {
        return {
          title: $("title").value.trim(),
          date: $("date").value,
          description: $("description").value.trim(),
          cover: $("coverSelect").value,
          category: $("category").value.trim() || "未分类",
          tags: $("tags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
          pinned: $("pinned").checked,
          pinOrder: Number($("pinOrder").value || 0),
          draft: $("draft").checked,
          content: $("content").value,
        };
      }

      function fillForm(post) {
        state.currentSlug = post.slug || "";
        $("title").value = post.title || "";
        $("date").value = String(post.date || "").slice(0, 10);
        $("slug").value = post.slug || "";
        $("description").value = post.description || "";
        $("coverSelect").value = post.cover || "";
        $("coverPreview").src = post.cover ? "assets/covers/" + post.cover : "assets/home-bg.jpg";
        $("category").value = post.category || "未分类";
        $("tags").value = Array.isArray(post.tags) ? post.tags.join(", ") : "";
        $("pinned").checked = Boolean(post.pinned);
        $("pinOrder").value = Number(post.pinOrder || 0);
        $("draft").checked = Boolean(post.draft);
        $("content").value = post.content || "";
        $("editorTitle").textContent = post.slug ? "编辑文章" : "新建文章";
        renderList();
      }

      function renderList() {
        const query = $("search").value.trim().toLowerCase();
        const list = $("postList");
        list.innerHTML = "";
        const posts = state.posts.filter((post) => {
          const haystack = [post.title, post.slug, post.category, (post.tags || []).join(" ")].join(" ").toLowerCase();
          return !query || haystack.includes(query);
        });
        for (const post of posts) {
          const item = document.createElement("button");
          item.className = "post-item " + (post.slug === state.currentSlug ? "active" : "");
          item.innerHTML = '<span class="post-title">' + (post.title || post.slug) + '</span>' +
            '<span class="post-meta">' + (post.pinned ? "置顶 · " : "") + (post.date || "无日期") + ' · ' + (post.category || "未分类") + ' · ' + ((post.tags || []).join(" / ") || "无标签") + (post.draft ? " · 草稿" : "") + '</span>';
          item.onclick = () => loadPost(post.slug);
          list.appendChild(item);
        }
      }

      async function loadPosts() {
        state.posts = await api("api/posts");
        renderList();
        setStatus("已加载 " + state.posts.length + " 篇文章");
      }

      async function loadPost(slug) {
        const post = await api("api/posts/" + encodeURIComponent(slug));
        fillForm(post);
        setStatus("正在编辑 " + slug + ".md");
      }

      function newPost() {
        const today = new Date().toISOString().slice(0, 10);
        fillForm({
          slug: "",
          title: "未命名文章",
          date: today,
          description: "",
          category: "未分类",
          tags: [],
          pinned: false,
          pinOrder: 0,
          draft: true,
          content: "## 小标题\\n\\n从这里开始写 Markdown。",
        });
        $("slug").value = "";
        state.currentSlug = "";
        setStatus("新建文章：填写 Slug 后保存");
      }

      async function saveCurrentPost() {
        const post = formToPost();
        let slug = slugify($("slug").value || post.title);
        if (!slug) throw new Error("请填写 Slug。");
        const saved = await api("api/posts/" + encodeURIComponent(slug), {
          method: "PUT",
          body: JSON.stringify(post),
        });
        if (state.currentSlug && state.currentSlug !== slug) {
          await api("api/posts/" + encodeURIComponent(state.currentSlug), { method: "DELETE" });
        }
        state.currentSlug = saved.slug;
        await loadPosts();
        await loadPost(saved.slug);
        setStatus("已保存 " + saved.slug + ".md");
      }

      async function deleteCurrentPost() {
        if (!state.currentSlug) return setStatus("当前没有已保存文章可删除", true);
        if (!confirm("确定删除 " + state.currentSlug + ".md 吗？此操作不可撤销。")) return;
        await api("api/posts/" + encodeURIComponent(state.currentSlug), { method: "DELETE" });
        state.currentSlug = "";
        await loadPosts();
        newPost();
        setStatus("文章已删除");
      }

      async function uploadBackground() {
        const file = $("bgFile").files[0];
        if (!file) throw new Error("请选择 JPEG 图片。");
        if (file.type !== "image/jpeg") throw new Error("当前只支持 JPEG 图片。");
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        await api("api/background", {
          method: "POST",
          body: JSON.stringify({ dataUrl }),
        });
        $("bgPreview").src = "assets/home-bg.jpg?v=" + Date.now();
        setStatus("首页背景已更新");
      }

      async function buildSite() {
        setStatus("正在构建站点，请稍候...");
        const result = await api("api/build", { method: "POST", body: "{}" });
        setStatus("构建完成，用时 " + Math.round(result.durationMs / 1000) + " 秒");
      }

      async function loadCoverList() {
        const covers = await api("api/covers");
        const sel = $("coverSelect");
        const current = sel.value;
        sel.innerHTML = '<option value="">默认封面</option>';
        covers.forEach(c => {
          sel.innerHTML += '<option value="' + c + '"' + (c === current ? ' selected' : '') + '>' + c + '</option>';
        });
      }

      async function uploadCover() {
        const file = $("coverFile").files[0];
        if (!file) { setStatus("请先选择封面图片文件"); return; }
        setStatus("正在上传封面...");
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const result = await api("api/covers", {
          method: "POST",
          body: JSON.stringify({ dataUrl, filename: file.name.replace(/\.[^.]+$/, "") }),
        });
        await loadCoverList();
        $("coverSelect").value = result.filename;
        $("coverPreview").src = "assets/covers/" + result.filename + "?v=" + Date.now();
        $("coverFile").value = "";
        setStatus("封面已上传");
      }

      $("refresh").onclick = () => loadPosts().catch((error) => setStatus(error.message, true));
      $("newPost").onclick = newPost;
      $("savePost").onclick = () => saveCurrentPost().catch((error) => setStatus(error.message, true));
      $("deletePost").onclick = () => deleteCurrentPost().catch((error) => setStatus(error.message, true));
      $("uploadBg").onclick = () => uploadBackground().catch((error) => setStatus(error.message, true));
      $("buildSite").onclick = () => buildSite().catch((error) => setStatus(error.message, true));
      $("search").oninput = renderList;
      $("uploadCover").onclick = () => uploadCover().catch((error) => setStatus(error.message, true));
      $("coverSelect").onchange = () => {
        const v = $("coverSelect").value;
        $("coverPreview").src = v ? "assets/covers/" + v : "assets/home-bg.jpg";
      };
      $("title").addEventListener("input", () => {
        if (!state.currentSlug && !$("slug").value.trim()) $("slug").value = slugify($("title").value);
      });

      loadPosts().then(() => {
        loadCoverList();
        if (state.posts[0]) loadPost(state.posts[0].slug);
        else newPost();
      }).catch((error) => setStatus(error.message, true));
    </script>
  </body>
</html>`;

async function handleRequest(req, res) {
  await ensureVersionStructure();
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  const pathname = stripBasePath(url.pathname);

  if (!isAuthorized(req)) {
    requireAuth(res);
    return;
  }

  try {
    if (req.method === "GET" && (pathname === "/" || pathname === "/admin")) {
      sendHtml(res, renderAdminPage());
      return;
    }

    if (req.method === "GET" && pathname === "/assets/home-bg.jpg") {
      sendBytes(res, await readFile(backgroundPath), "image/jpeg");
      return;
    }

    if (req.method === "GET" && pathname === "/api/posts") {
      sendJson(res, await listPosts());
      return;
    }

    if (pathname.startsWith("/api/posts/")) {
      const slug = decodeSlugFromPath(pathname);
      if (req.method === "GET") {
        sendJson(res, await loadPost(slug));
        return;
      }
      if (req.method === "PUT") {
        const post = await savePost(slug, await readJson(req));
        const build = await maybeBuild();
        sendJson(res, { ...post, build });
        return;
      }
      if (req.method === "DELETE") {
        await createSnapshot(`delete-post:${slug}`);
        await unlink(postPathFromSlug(slug));
        const build = await maybeBuild();
        sendJson(res, { ok: true, build });
        return;
      }
    }

    if (req.method === "GET" && pathname === "/api/covers") {
      await mkdir(coversDir, { recursive: true });
      const files = await readdir(coversDir);
      const covers = files.filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
      sendJson(res, covers);
      return;
    }

    if (req.method === "POST" && pathname === "/api/covers") {
      await mkdir(coversDir, { recursive: true });
      const payload = await readJson(req);
      const match = String(payload.dataUrl || "").match(/^data:image\/(jpeg|png|webp);base64,([\s\S]+)$/);
      if (!match) throw new Error("Only JPEG, PNG or WebP images are supported for covers.");
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.length > 4 * 1024 * 1024) throw new Error("Cover must be smaller than 4MB.");
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const filename = `${payload.filename || "cover"}.${ext}`;
      await writeFile(resolve(coversDir, filename), bytes);
      sendJson(res, { ok: true, filename });
      return;
    }

    if (req.method === "POST" && pathname === "/api/background") {
      const payload = await readJson(req);
      const background = await saveBackground(payload.dataUrl);
      const build = await maybeBuild();
      sendJson(res, { ...background, build });
      return;
    }

    if (req.method === "POST" && pathname === "/api/build") {
      sendJson(res, await runBuild());
      return;
    }

    sendJson(res, { error: "Not found", requestId: randomUUID() }, 404);
  } catch (error) {
    sendJson(res, { error: error.message || "Unknown error" }, 400);
  }
}

createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendJson(res, { error: error.message || "Unexpected server error" }, 500);
  });
}).listen(port, host, () => {
  console.log(`Afu Blog Admin: http://${host}:${port}/admin`);
  console.log(`User: ${adminUser}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log("Password: afu-admin");
    console.log("Set ADMIN_PASSWORD to change the default local password.");
  }
});
