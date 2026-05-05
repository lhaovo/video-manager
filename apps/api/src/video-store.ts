import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { copyThenRemoveFile, moveFile, statFile } from "./file-utils.js";
import {
  buildManagedFileName,
  nextAvailablePath,
  readDurationSeconds,
  statusForLibrary,
  toRelativePath,
  walkVideoFiles
} from "./media.js";
import { Library, Status, VideoRow } from "./types.js";

export type StoredVideo = {
  id: number;
  library: Library;
  relative_path: string;
  file_name: string;
  file_size: number;
  duration_seconds: number;
  status: Status;
  file_mtime_ms: number | null;
};

export function rootDirForLibrary(library: Library) {
  return config.videoDirs[library];
}

export function fullPathForVideo(video: Pick<StoredVideo, "library" | "relative_path">) {
  return path.join(rootDirForLibrary(video.library), video.relative_path);
}

export function getVideo(id: number) {
  return db.prepare("select * from videos where id = ?").get(id) as StoredVideo | undefined;
}

export function getVideoRequired(id: number) {
  const video = getVideo(id);
  if (!video) {
    throw new Error("Video not found.");
  }
  return video;
}

export function getPublicationNames(videoId: number) {
  return db
    .prepare(
      `
      select p.name
      from video_publications vp
      join platforms p on p.id = vp.platform_id
      where vp.video_id = ?
      order by p.sort_order asc, p.name asc
      `
    )
    .all(videoId)
    .map((row) => (row as { name: string }).name);
}

export function getVideoIdsForPlatform(platformId: number) {
  return db
    .prepare("select video_id from video_publications where platform_id = ?")
    .all(platformId)
    .map((row) => (row as { video_id: number }).video_id);
}

export function sanitizeUploadFileName(fileName: string) {
  const parsed = path.parse(fileName);
  const base = parsed.name
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._ ]+|[._ ]+$/g, "")
    .slice(0, 100);
  const ext = parsed.ext.toLowerCase();
  return `${base || "upload"}${ext}`;
}

export async function renameFileForRule(params: {
  library: Library;
  filePath: string;
  status: Status;
  platformNames: string[];
}) {
  const rootDir = rootDirForLibrary(params.library);
  const stat = await statFile(params.filePath);

  if (params.library === "unprocessed") {
    return {
      fullPath: params.filePath,
      relativePath: toRelativePath(rootDir, params.filePath),
      fileName: path.basename(params.filePath),
      fileSize: stat.size,
      fileMtimeMs: Math.round(stat.mtimeMs)
    };
  }

  const extension = path.extname(params.filePath);
  const desiredName = buildManagedFileName(stat.mtimeMs, extension, params.status, params.platformNames);
  const desiredPath = path.join(path.dirname(params.filePath), desiredName);
  const targetPath = await nextAvailablePath(params.filePath, desiredPath);

  if (targetPath !== params.filePath) {
    if (params.library === "processed") {
      await copyThenRemoveFile(params.filePath, targetPath);
    } else {
      await moveFile(params.filePath, targetPath);
    }
  }

  const nextStat = await statFile(targetPath);
  return {
    fullPath: targetPath,
    relativePath: toRelativePath(rootDir, targetPath),
    fileName: path.basename(targetPath),
    fileSize: nextStat.size,
    fileMtimeMs: Math.round(nextStat.mtimeMs)
  };
}

export async function renameStoredVideo(videoId: number) {
  const video = getVideo(videoId);
  if (!video) return;

  const currentPath = fullPathForVideo(video);
  const renamed = await renameFileForRule({
    library: video.library,
    filePath: currentPath,
    status: video.status,
    platformNames: getPublicationNames(videoId)
  });

  db.prepare(
    `
    update videos
    set relative_path = ?, file_name = ?, file_size = ?, file_mtime_ms = ?
    where id = ?
    `
  ).run(renamed.relativePath, renamed.fileName, renamed.fileSize, renamed.fileMtimeMs, videoId);
}

export async function moveStoredVideoToLibrary(videoId: number, nextLibrary: Library) {
  const video = getVideo(videoId);
  if (!video) return;

  if (video.library === nextLibrary) {
    await renameStoredVideo(videoId);
    return;
  }

  const currentPath = fullPathForVideo(video);
  const targetRoot = rootDirForLibrary(nextLibrary);
  await fs.mkdir(targetRoot, { recursive: true });
  const targetPath = await nextAvailablePath(currentPath, path.join(targetRoot, video.file_name));
  await moveFile(currentPath, targetPath);

  const moved = await renameFileForRule({
    library: nextLibrary,
    filePath: targetPath,
    status: nextLibrary,
    platformNames: getPublicationNames(videoId)
  });

  db.prepare(
    `
    update videos
    set library = ?, status = ?, relative_path = ?, file_name = ?, file_size = ?, file_mtime_ms = ?
    where id = ?
    `
  ).run(nextLibrary, nextLibrary, moved.relativePath, moved.fileName, moved.fileSize, moved.fileMtimeMs, videoId);
}

export async function scanLibrary(library: Library) {
  const rootDir = rootDirForLibrary(library);
  const inserted: number[] = [];
  const skipped: string[] = [];
  const seenRelativePaths = new Set<string>();

  await fs.mkdir(rootDir, { recursive: true });

  for await (const filePath of walkVideoFiles(rootDir)) {
    const relativePath = toRelativePath(rootDir, filePath);
    const existing = db
      .prepare("select id from videos where library = ? and relative_path = ?")
      .get(library, relativePath) as { id: number } | undefined;

    if (existing) {
      await renameStoredVideo(existing.id);
      const current = getVideo(existing.id);
      if (current) {
        seenRelativePaths.add(current.relative_path);
        skipped.push(current.relative_path);
      }
      continue;
    }

    const status = statusForLibrary(library);
    const renamed = await renameFileForRule({ library, filePath, status, platformNames: [] });
    const existingAfterRename = db
      .prepare("select id from videos where library = ? and relative_path = ?")
      .get(library, renamed.relativePath) as { id: number } | undefined;

    if (existingAfterRename) {
      seenRelativePaths.add(renamed.relativePath);
      skipped.push(renamed.relativePath);
      continue;
    }

    const duration = await readDurationSeconds(renamed.fullPath);
    const result = db
      .prepare(
        `
        insert into videos (library, relative_path, file_name, file_size, duration_seconds, status, file_mtime_ms)
        values (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(library, renamed.relativePath, renamed.fileName, renamed.fileSize, duration, status, renamed.fileMtimeMs);

    inserted.push(Number(result.lastInsertRowid));
    seenRelativePaths.add(renamed.relativePath);
  }

  const staleRows = db.prepare("select id, relative_path from videos where library = ?").all(library) as Array<{
    id: number;
    relative_path: string;
  }>;
  let deletedCount = 0;
  const deleteVideo = db.prepare("delete from videos where id = ?");

  for (const row of staleRows) {
    if (seenRelativePaths.has(row.relative_path)) continue;
    const fullPath = path.join(rootDir, row.relative_path);
    try {
      await fs.access(fullPath);
      continue;
    } catch {
      deleteVideo.run(row.id);
      deletedCount += 1;
    }
  }

  return { library, rootDir, insertedCount: inserted.length, skippedCount: skipped.length, deletedCount };
}

export async function deleteStoredVideo(videoId: number) {
  const video = getVideo(videoId);
  if (!video) return;

  const pendingOutputs = db
    .prepare(
      `
      select output_relative_path
      from processing_jobs
      where (source_video_id = ? or output_video_id = ?)
        and output_relative_path is not null
      `
    )
    .all(videoId, videoId) as Array<{ output_relative_path: string }>;

  for (const output of pendingOutputs) {
    await fs.rm(path.join(rootDirForLibrary("processing"), output.output_relative_path), { force: true }).catch(() => undefined);
  }

  await fs.rm(fullPathForVideo(video), { force: true });
  db.prepare("delete from videos where id = ?").run(videoId);
}

export function listVideos(query: Record<string, unknown>) {
  const filters: string[] = ["v.library != 'processing'"];
  const params: Record<string, unknown> = {};
  const unresolvedJobFilter = `
    select 1 from processing_jobs j
    where j.source_video_id = v.id
      and j.cancel_requested = 0
      and (
        j.status in ('queued', 'running', 'confirming', 'failed')
        or (j.status = 'completed' and j.output_video_id is null and j.output_relative_path is not null)
      )
  `;

  const status = String(query.status ?? "all");
  if (status === "processing") {
    filters.push(`(v.status = 'processing' or exists (${unresolvedJobFilter}))`);
  } else if (status === "unprocessed") {
    filters.push(`v.status = 'unprocessed' and not exists (${unresolvedJobFilter})`);
  } else if (status === "archived") {
    filters.push("v.status = @status");
    params.status = status;
  } else if (status === "processed") {
    filters.push("v.status = @status");
    params.status = status;
  }

  const duration = String(query.duration ?? "all");
  if (duration === "lt_1m") filters.push("v.duration_seconds < 60");
  if (duration === "1_5m") filters.push("v.duration_seconds >= 60 and v.duration_seconds < 300");
  if (duration === "5_15m") filters.push("v.duration_seconds >= 300 and v.duration_seconds < 900");
  if (duration === "gte_15m") filters.push("v.duration_seconds >= 900");

  const platform = String(query.platform ?? "all");
  if (platform === "unpublished") {
    filters.push("not exists (select 1 from video_publications vp where vp.video_id = v.id)");
  } else if (platform !== "all") {
    filters.push("exists (select 1 from video_publications vp where vp.video_id = v.id and vp.platform_id = @platformId)");
    params.platformId = Number(platform);
  }

  const search = String(query.search ?? "").trim();
  if (search) {
    filters.push("v.file_name like @search");
    params.search = `%${search}%`;
  }

  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  return db
    .prepare(
      `
      select
        v.*,
        group_concat(p.name, ', ') as publication_platforms,
        group_concat(p.id, ',') as publication_platform_ids
      from videos v
      left join video_publications vp on vp.video_id = v.id
      left join platforms p on p.id = vp.platform_id
      ${where}
      group by v.id
      order by v.created_at desc, v.id desc
      limit 500
      `
    )
    .all(params) as VideoRow[];
}
