import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(__dirname, "..");
export const versionsDir = resolve(rootDir, "versions");
export const currentDir = resolve(versionsDir, "current");
export const currentPostsDir = resolve(currentDir, "posts");
export const currentAssetsDir = resolve(currentDir, "assets");
export const snapshotsDir = resolve(versionsDir, "snapshots");
export const publicAssetsDir = resolve(rootDir, "public", "assets");
export const publicBackgroundPath = resolve(publicAssetsDir, "home-bg.jpg");
export const currentBackgroundPath = resolve(currentAssetsDir, "home-bg.jpg");
const legacyPostsDir = resolve(rootDir, "src", "content", "posts");
const legacyBackgroundPath = resolve(rootDir, "public", "assets", "home-bg.jpg");

export async function ensureVersionStructure() {
  await mkdir(currentPostsDir, { recursive: true });
  await mkdir(currentAssetsDir, { recursive: true });
  await mkdir(snapshotsDir, { recursive: true });
  await mkdir(publicAssetsDir, { recursive: true });

  const hasCurrentPosts = (await readdir(currentPostsDir)).length > 0;
  if (!hasCurrentPosts) {
    await copyDirectoryContents(legacyPostsDir, currentPostsDir);
  }

  if (!(await exists(currentBackgroundPath)) && (await exists(legacyBackgroundPath))) {
    await copyFile(legacyBackgroundPath, currentBackgroundPath);
  }
}

export async function syncPublicAssets() {
  await ensureVersionStructure();

  if (await exists(currentBackgroundPath)) {
    await copyFile(currentBackgroundPath, publicBackgroundPath);
  }
}

export async function createSnapshot(reason = "manual") {
  await ensureVersionStructure();

  const createdAt = new Date().toISOString();
  const id = createdAt.replace(/[:.]/g, "-");
  const snapshotDir = resolve(snapshotsDir, id);

  await mkdir(snapshotDir, { recursive: true });
  await mkdir(resolve(snapshotDir, "posts"), { recursive: true });
  await mkdir(resolve(snapshotDir, "assets"), { recursive: true });
  await copyDirectoryContents(currentPostsDir, resolve(snapshotDir, "posts"));
  await copyDirectoryContents(currentAssetsDir, resolve(snapshotDir, "assets"));

  const metadata = {
    id,
    reason,
    createdAt,
  };

  await writeFile(resolve(snapshotDir, "meta.json"), JSON.stringify(metadata, null, 2), "utf8");
  return metadata;
}

export async function listSnapshots(limit = 20) {
  await ensureVersionStructure();

  const entries = await readdir(snapshotsDir, { withFileTypes: true });
  const snapshots = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const snapshotDir = resolve(snapshotsDir, entry.name);
    const metadataPath = resolve(snapshotDir, "meta.json");

    let metadata;
    if (await exists(metadataPath)) {
      metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    } else {
      const info = await stat(snapshotDir);
      metadata = {
        id: entry.name,
        reason: "unknown",
        createdAt: info.mtime.toISOString(),
      };
    }

    snapshots.push(metadata);
  }

  snapshots.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return snapshots.slice(0, limit);
}

export async function restoreSnapshot(id) {
  await ensureVersionStructure();

  const snapshotId = normalizeSnapshotId(id);
  const snapshotDir = resolve(snapshotsDir, snapshotId);
  const snapshotPostsDir = resolve(snapshotDir, "posts");
  const snapshotAssetsDir = resolve(snapshotDir, "assets");

  if (!(await exists(snapshotDir))) {
    throw new Error(`Snapshot not found: ${snapshotId}`);
  }

  await rm(currentPostsDir, { recursive: true, force: true });
  await rm(currentAssetsDir, { recursive: true, force: true });
  await mkdir(currentPostsDir, { recursive: true });
  await mkdir(currentAssetsDir, { recursive: true });

  await copyDirectoryContents(snapshotPostsDir, currentPostsDir);
  await copyDirectoryContents(snapshotAssetsDir, currentAssetsDir);
  await syncPublicAssets();

  const metadataPath = resolve(snapshotDir, "meta.json");
  if (await exists(metadataPath)) {
    return JSON.parse(await readFile(metadataPath, "utf8"));
  }

  return { id: snapshotId, restoredAt: new Date().toISOString() };
}

async function copyDirectoryContents(sourceDir, targetDir) {
  if (!(await exists(sourceDir))) return;

  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeSnapshotId(id) {
  const value = String(id || "").trim();
  if (!/^[0-9TZ-]+$/.test(value)) {
    throw new Error("Invalid snapshot id.");
  }
  return value;
}
