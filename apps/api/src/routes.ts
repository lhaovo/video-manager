import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import { moveFile } from "./file-utils.js";
import { nextAvailablePath, readDurationSeconds, statusForLibrary } from "./media.js";
import { parseId, userVideoLibrarySchema, userVideoStatusSchema } from "./schemas.js";
import { Library, PlatformRow } from "./types.js";
import {
  StoredVideo,
  deleteStoredVideo,
  fullPathForVideo,
  getVideo,
  getVideoIdsForPlatform,
  getVideoRequired,
  listVideos,
  moveStoredVideoToLibrary,
  renameFileForRule,
  renameStoredVideo,
  rootDirForLibrary,
  sanitizeUploadFileName,
  scanLibrary
} from "./video-store.js";
const contentTypes: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo"
};

type ClipCut = { start: number; end: number };
type SubtitleArea = [number, number, number, number];
type VideoProcessOptions = {
  cuts?: ClipCut[];
  clipMode?: "accurate" | "lossless";
  subtitle?: {
    enabled?: boolean;
    mode?: "sttn-auto" | "sttn-det" | "lama" | "propainter" | "opencv";
    areas?: SubtitleArea[];
  };
};
type ProcessingJobRow = {
  id: number;
  source_video_id: number;
  output_video_id: number | null;
  type: string;
  status: "queued" | "running" | "completed" | "confirming" | "failed";
  progress: number;
  mode: string;
  cuts_json: string;
  message: string;
  error: string;
  output_relative_path: string | null;
  output_file_name: string | null;
  cancel_requested: number;
  log_json: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

type VsrJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  error: string | null;
  output: string;
  log?: string[];
};

let queueRunning = false;
const activeFfmpegProcesses = new Map<number, ReturnType<typeof spawn>>();

async function sendVideoFile(reply: FastifyReply, filePath: string, fileName: string, range?: string, disposition: "inline" | "attachment" = "inline") {
  const stat = await fs.stat(filePath);
  const fileSize = stat.size;
  const contentType = contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";

  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", contentType);
  reply.header("Content-Disposition", `${disposition}; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);

  if (!range) {
    reply.header("Content-Length", fileSize);
    return reply.send(createReadStream(filePath));
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    reply.header("Content-Range", `bytes */${fileSize}`);
    return reply.code(416).send();
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= fileSize) {
    reply.header("Content-Range", `bytes */${fileSize}`);
    return reply.code(416).send();
  }

  const safeEnd = Math.min(end, fileSize - 1);
  const chunkSize = safeEnd - start + 1;

  reply.code(206);
  reply.header("Content-Length", chunkSize);
  reply.header("Content-Range", `bytes ${start}-${safeEnd}/${fileSize}`);
  return reply.send(createReadStream(filePath, { start, end: safeEnd }));
}

function normalizeCuts(cuts: ClipCut[], duration: number) {
  const normalized = cuts
    .map((cut) => ({
      start: Math.max(0, Math.min(duration, cut.start)),
      end: Math.max(0, Math.min(duration, cut.end))
    }))
    .filter((cut) => cut.end > cut.start)
    .sort((a, b) => a.start - b.start);

  const merged: ClipCut[] = [];
  for (const cut of normalized) {
    const previous = merged[merged.length - 1];
    if (previous && cut.start <= previous.end) {
      previous.end = Math.max(previous.end, cut.end);
    } else {
      merged.push({ ...cut });
    }
  }
  return merged;
}

function keepSegmentsFromCuts(cuts: ClipCut[], duration: number) {
  const segments: ClipCut[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) {
      segments.push({ start: cursor, end: cut.start });
    }
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < duration) {
    segments.push({ start: cursor, end: duration });
  }
  return segments.filter((segment) => segment.end - segment.start > 0.05);
}

function secondsToFfmpegTime(seconds: number) {
  return seconds.toFixed(3);
}

async function hasAudioStream(filePath: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", filePath]);
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(stdout.includes("audio")));
  });
}

function runFfmpeg(args: string[], duration: number, onProgress: (progress: number) => void, jobId?: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [...args, "-progress", "pipe:1", "-nostats"], { stdio: ["ignore", "pipe", "pipe"] });
    if (jobId !== undefined) {
      activeFfmpegProcesses.set(jobId, child);
    }
    let stderr = "";
    let lastLoggedProgress = -10;
    child.stdout.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.startsWith("out_time_ms=")) {
          const microseconds = Number(line.slice("out_time_ms=".length));
          if (Number.isFinite(microseconds) && duration > 0) {
            const progress = Math.min(95, Math.max(1, (microseconds / 1_000_000 / duration) * 95));
            onProgress(progress);
            const rounded = Math.floor(progress / 10) * 10;
            if (jobId !== undefined && rounded >= lastLoggedProgress + 10) {
              lastLoggedProgress = rounded;
              appendJobLog(jobId, `ffmpeg 处理进度 ${Math.round(progress)}%`);
            }
          }
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (jobId !== undefined) {
        activeFfmpegProcesses.delete(jobId);
      }
      if (code === 0) {
        if (jobId !== undefined) appendJobLog(jobId, "ffmpeg 阶段完成");
        resolve();
      } else {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

function ensureJobNotCancelled(jobId: number) {
  const row = db.prepare("select cancel_requested from processing_jobs where id = ?").get(jobId) as { cancel_requested: number } | undefined;
  if (row?.cancel_requested) {
    throw new Error("已取消");
  }
}

function appendJobLog(jobId: number, message: string) {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${message}`;
  const row = db.prepare("select log_json from processing_jobs where id = ?").get(jobId) as { log_json: string } | undefined;
  let logs: string[] = [];
  if (row?.log_json) {
    try {
      const parsed = JSON.parse(row.log_json);
      if (Array.isArray(parsed)) {
        logs = parsed.map(String);
      }
    } catch {
      logs = [];
    }
  }
  logs.push(line);
  logs = logs.slice(-300);
  db.prepare("update processing_jobs set log_json = ? where id = ?").run(JSON.stringify(logs), jobId);
}

function updateJobMessage(jobId: number, message: string) {
  db.prepare("update processing_jobs set message = ? where id = ?").run(message, jobId);
  appendJobLog(jobId, message);
}

function markSourceVideoProcessing(videoId: number) {
  db.prepare("update videos set status = 'processing' where id = ? and library = 'unprocessed'").run(videoId);
}

function markSourceVideoUnprocessed(videoId: number) {
  db.prepare("update videos set status = 'unprocessed' where id = ? and library = 'unprocessed'").run(videoId);
}

function reconcileProcessingVideoStatuses() {
  db.prepare("update processing_jobs set status = 'queued', message = '等待恢复处理' where status = 'running'").run();
  db.prepare("update processing_jobs set status = 'completed', message = '确认中断，可重新确认' where status = 'confirming'").run();

  db.prepare(
    `
    update videos
    set status = 'processing'
    where library = 'unprocessed'
      and exists (
        select 1
        from processing_jobs j
        where j.source_video_id = videos.id
          and j.cancel_requested = 0
          and (
            j.status in ('queued', 'running', 'confirming', 'failed')
            or (j.status = 'completed' and j.output_video_id is null and j.output_relative_path is not null)
          )
      )
    `
  ).run();

  db.prepare(
    `
    update videos
    set status = 'unprocessed'
    where library = 'unprocessed'
      and status = 'processing'
      and not exists (
        select 1
        from processing_jobs j
        where j.source_video_id = videos.id
          and j.cancel_requested = 0
          and (
            j.status in ('queued', 'running', 'confirming', 'failed')
            or (j.status = 'completed' and j.output_video_id is null and j.output_relative_path is not null)
          )
      )
    `
  ).run();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function vsrUrl(pathname: string) {
  return new URL(pathname, config.vsrApiUrl.endsWith("/") ? config.vsrApiUrl : `${config.vsrApiUrl}/`);
}

async function requestVsr<T>(pathname: string, init?: RequestInit) {
  const signal = AbortSignal.timeout(10_000);
  const response = await fetch(vsrUrl(pathname), {
    ...init,
    signal,
    headers: {
      ...(init?.headers ?? {}),
      ...(typeof init?.body === "string" ? { "Content-Type": "application/json" } : {})
    }
  });
  if (!response.ok) {
    throw new Error(`VSR API ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function localWorkPath(prefix: string, extension: string) {
  const dir = path.join(rootDirForLibrary("processing"), ".work");
  await fs.mkdir(dir, { recursive: true });
  return nextAvailablePath("", path.join(dir, `${prefix}-${Date.now()}${extension || ".mp4"}`));
}

async function preparePendingJobOutput(params: {
  source: StoredVideo;
  outputPath: string;
  jobId: number;
}) {
  const inputPath = fullPathForVideo(params.source);
  const sourceStat = await fs.stat(inputPath);
  const processingRoot = rootDirForLibrary("processing");
  await fs.mkdir(processingRoot, { recursive: true });

  let stagedPath = params.outputPath;
  const resolvedOutput = path.resolve(params.outputPath);
  const resolvedProcessingRoot = path.resolve(processingRoot);
  if (!resolvedOutput.startsWith(resolvedProcessingRoot + path.sep)) {
    const targetPath = await nextAvailablePath("", path.join(processingRoot, path.basename(params.outputPath)));
    appendJobLog(params.jobId, "处理结果移动到待确认目录");
    await moveFile(params.outputPath, targetPath);
    stagedPath = targetPath;
    appendJobLog(params.jobId, "处理结果已写入待确认目录");
  }

  await fs.utimes(stagedPath, sourceStat.mtime, sourceStat.mtime);

  const renamed = await renameFileForRule({
    library: "processing",
    filePath: stagedPath,
    status: "processing",
    platformNames: []
  });

  return {
    relativePath: renamed.relativePath,
    fileName: renamed.fileName
  };
}

async function confirmPendingJobOutput(job: ProcessingJobRow) {
  if (!job.output_relative_path) {
    throw new Error("任务没有可确认的输出文件。");
  }

  const source = getVideoRequired(job.source_video_id);
  const sourceStat = await fs.stat(fullPathForVideo(source));
  const currentPath = path.join(rootDirForLibrary("processing"), job.output_relative_path);
  const targetRoot = rootDirForLibrary("processed");
  await fs.mkdir(targetRoot, { recursive: true });
  const targetPath = await nextAvailablePath("", path.join(targetRoot, job.output_file_name || path.basename(currentPath)));
  await moveFile(currentPath, targetPath);
  await fs.utimes(targetPath, sourceStat.mtime, sourceStat.mtime);

  const renamed = await renameFileForRule({
    library: "processed",
    filePath: targetPath,
    status: "processed",
    platformNames: []
  });
  const duration = await readDurationSeconds(renamed.fullPath);
  const result = db
    .prepare(
      `
      insert into videos (library, relative_path, file_name, file_size, duration_seconds, status, note, file_mtime_ms)
      values ('processed', ?, ?, ?, ?, 'processed', ?, ?)
      `
    )
    .run(renamed.relativePath, renamed.fileName, renamed.fileSize, duration, `原文件名：${source.file_name}`, renamed.fileMtimeMs);

  return Number(result.lastInsertRowid);
}

async function runConfirmJob(jobId: number) {
  const job = db.prepare("select * from processing_jobs where id = ?").get(jobId) as ProcessingJobRow | undefined;
  if (!job) return;

  try {
    appendJobLog(jobId, "确认入库开始");
    const outputVideoId = job.output_video_id ?? (await confirmPendingJobOutput(job));
    db.prepare("update processing_jobs set output_video_id = ?, message = '处理结果已入已处理库，正在归档原视频' where id = ?").run(outputVideoId, jobId);
    appendJobLog(jobId, "处理结果已加入已处理库");
    await moveStoredVideoToLibrary(job.source_video_id, "archived");
    db.prepare("update processing_jobs set status = 'completed', output_video_id = ?, message = '已确认入已处理库', completed_at = datetime('now') where id = ?").run(
      outputVideoId,
      jobId
    );
    appendJobLog(jobId, "确认完成，原视频已归档");
  } catch (error) {
    db.prepare("update processing_jobs set status = 'completed', message = '确认失败，可重试', error = ? where id = ?").run(
      error instanceof Error ? error.message : String(error),
      jobId
    );
    appendJobLog(jobId, `确认失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function renderClipToFile(params: {
  inputPath: string;
  outputPath: string;
  duration: number;
  cuts: ClipCut[];
  mode: string;
  onProgress: (progress: number) => void;
  jobId: number;
}) {
  appendJobLog(params.jobId, `剪辑阶段开始，模式：${params.mode}`);
  ensureJobNotCancelled(params.jobId);
  const cuts = normalizeCuts(params.cuts, params.duration);
  const keepSegments = keepSegmentsFromCuts(cuts, params.duration);

  if (!keepSegments.length) {
    throw new Error("剪辑片段会删除整个视频。");
  }

  const audio = await hasAudioStream(params.inputPath);
  const canUseLossless = params.mode === "lossless" && keepSegments.length === 1;
  appendJobLog(params.jobId, `剪辑保留片段 ${keepSegments.length} 段，音频流：${audio ? "有" : "无"}`);

  if (canUseLossless) {
    const [segment] = keepSegments;
    await runFfmpeg(
      ["-y", "-ss", secondsToFfmpegTime(segment.start), "-to", secondsToFfmpegTime(segment.end), "-i", params.inputPath, "-c", "copy", params.outputPath],
      segment.end - segment.start,
      params.onProgress,
      params.jobId
    );
    ensureJobNotCancelled(params.jobId);
    return;
  }

  const filterParts: string[] = [];
  const concatInputs: string[] = [];
  keepSegments.forEach((segment, index) => {
    filterParts.push(`[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${index}]`);
    concatInputs.push(`[v${index}]`);
    if (audio) {
      filterParts.push(`[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${index}]`);
      concatInputs.push(`[a${index}]`);
    }
  });
  filterParts.push(`${concatInputs.join("")}concat=n=${keepSegments.length}:v=1:a=${audio ? 1 : 0}[outv]${audio ? "[outa]" : ""}`);
  const args = ["-y", "-i", params.inputPath, "-filter_complex", filterParts.join(";"), "-map", "[outv]"];
  if (audio) {
    args.push("-map", "[outa]");
  }
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "22", params.outputPath);
  await runFfmpeg(args, keepSegments.reduce((sum, item) => sum + item.end - item.start, 0), params.onProgress, params.jobId);
  ensureJobNotCancelled(params.jobId);
}

async function renderSubtitleToFile(params: {
  jobId: number;
  inputPath: string;
  outputPath: string;
  mode: string;
  areas: SubtitleArea[];
  baseProgress: number;
  spanProgress: number;
}) {
  appendJobLog(params.jobId, `去字幕阶段开始，模式：${params.mode}，区域数：${params.areas.length}`);
  const vsrJob = await requestVsr<VsrJob>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      input: params.inputPath,
      output: params.outputPath,
      mode: params.mode || "sttn-auto",
      areas: params.areas
    })
  });

  updateJobMessage(params.jobId, `VSR 任务 ${vsrJob.id}`);
  let lastVsrLogCount = 0;
  let lastLoggedProgress = -10;

  while (true) {
    if ((db.prepare("select cancel_requested from processing_jobs where id = ?").get(params.jobId) as { cancel_requested: number } | undefined)?.cancel_requested) {
      await requestVsr(`/api/jobs/${vsrJob.id}/cancel`, { method: "POST" }).catch(() => undefined);
      throw new Error("已取消");
    }
    let current: VsrJob;
    try {
      current = await requestVsr<VsrJob>(`/api/jobs/${vsrJob.id}`);
    } catch (error) {
      appendJobLog(params.jobId, `VSR 状态查询暂无响应，继续等待：${error instanceof Error ? error.message : String(error)}`);
      await sleep(3000);
      continue;
    }
    const vsrProgress = Math.max(0, Math.min(99, current.progress ?? 0));
    const vsrLogs = Array.isArray(current.log) ? current.log : [];
    for (const line of vsrLogs.slice(lastVsrLogCount)) {
      appendJobLog(params.jobId, `VSR: ${line}`);
    }
    lastVsrLogCount = vsrLogs.length;
    const rounded = Math.floor(vsrProgress / 10) * 10;
    if (rounded >= lastLoggedProgress + 10) {
      lastLoggedProgress = rounded;
      appendJobLog(params.jobId, `VSR 进度 ${vsrProgress}%`);
    }
    db.prepare("update processing_jobs set progress = ?, message = ? where id = ?").run(
      params.baseProgress + (vsrProgress / 100) * params.spanProgress,
      `VSR ${current.status}`,
      params.jobId
    );

    if (current.status === "succeeded") {
      break;
    }
    if (current.status === "failed" || current.status === "cancelled") {
      throw new Error(current.error || `VSR task ${current.status}`);
    }
    await sleep(1500);
  }
}

async function runClipJob(job: ProcessingJobRow) {
  const source = getVideoRequired(job.source_video_id);
  const inputPath = fullPathForVideo(source);
  const duration = source.duration_seconds || (await readDurationSeconds(inputPath));
  const cuts = JSON.parse(job.cuts_json) as ClipCut[];

  const tempOutput = await localWorkPath(`clip-${source.id}`, path.extname(source.file_name) || ".mp4");

  db.prepare("update processing_jobs set status = 'running', started_at = datetime('now'), message = ? where id = ?").run(
    job.mode === "lossless" ? "快速无损剪辑处理中" : "精确剪辑处理中",
    job.id
  );
  appendJobLog(job.id, `任务开始：剪辑 ${source.file_name}`);

  const updateProgress = (progress: number) => {
    db.prepare("update processing_jobs set progress = ? where id = ?").run(progress, job.id);
  };

  await renderClipToFile({ inputPath, outputPath: tempOutput, duration, cuts, mode: job.mode, onProgress: updateProgress, jobId: job.id });

  const pendingOutput = await preparePendingJobOutput({
    source,
    outputPath: tempOutput,
    jobId: job.id
  });

  db.prepare(
    "update processing_jobs set status = 'completed', progress = 100, output_relative_path = ?, output_file_name = ?, completed_at = datetime('now'), message = '剪辑完成，等待确认入库' where id = ?"
  ).run(pendingOutput.relativePath, pendingOutput.fileName, job.id);
  appendJobLog(job.id, "剪辑完成，等待确认入库");
}

async function runSubtitleRemoveJob(job: ProcessingJobRow) {
  const source = getVideoRequired(job.source_video_id);
  const inputPath = fullPathForVideo(source);
  const options = JSON.parse(job.cuts_json || "{}") as { areas?: SubtitleArea[] };
  const areas = Array.isArray(options.areas) ? options.areas : [];
  const tempOutput = await localWorkPath(`subtitle-${source.id}`, path.extname(source.file_name) || ".mp4");

  db.prepare("update processing_jobs set status = 'running', started_at = datetime('now'), message = ? where id = ?").run(
    "去字幕处理中",
    job.id
  );
  appendJobLog(job.id, `任务开始：去字幕 ${source.file_name}`);

  await renderSubtitleToFile({ jobId: job.id, inputPath, outputPath: tempOutput, mode: job.mode, areas, baseProgress: 0, spanProgress: 99 });

  const pendingOutput = await preparePendingJobOutput({
    source,
    outputPath: tempOutput,
    jobId: job.id
  });

  db.prepare(
    "update processing_jobs set status = 'completed', progress = 100, output_relative_path = ?, output_file_name = ?, completed_at = datetime('now'), message = '去字幕完成，等待确认入库' where id = ?"
  ).run(pendingOutput.relativePath, pendingOutput.fileName, job.id);
  appendJobLog(job.id, "去字幕完成，等待确认入库");
}

async function runVideoProcessJob(job: ProcessingJobRow) {
  const source = getVideoRequired(job.source_video_id);
  const inputPath = fullPathForVideo(source);
  const duration = source.duration_seconds || (await readDurationSeconds(inputPath));
  const options = JSON.parse(job.cuts_json || "{}") as VideoProcessOptions;
  const cuts = Array.isArray(options.cuts) ? options.cuts : [];
  const subtitle = options.subtitle ?? {};
  const subtitleEnabled = Boolean(subtitle.enabled);

  if (!cuts.length && !subtitleEnabled) {
    throw new Error("请至少配置剪辑或去字幕处理。");
  }

  const extension = path.extname(source.file_name) || ".mp4";
  let currentPath = inputPath;
  const intermediateFiles: string[] = [];

  db.prepare("update processing_jobs set status = 'running', started_at = datetime('now'), message = '处理任务开始' where id = ?").run(job.id);
  appendJobLog(job.id, `任务开始：综合处理 ${source.file_name}`);

  if (cuts.length) {
    const clipOutput = await localWorkPath(`task-clip-${source.id}`, extension);
    updateJobMessage(job.id, "剪辑处理中");
    await renderClipToFile({
      inputPath: currentPath,
      outputPath: clipOutput,
      duration,
      cuts,
      mode: options.clipMode ?? "accurate",
      jobId: job.id,
      onProgress: (progress) => {
        const scaled = subtitleEnabled ? progress * 0.45 : progress;
        db.prepare("update processing_jobs set progress = ? where id = ?").run(scaled, job.id);
      }
    });
    if (currentPath !== inputPath) {
      intermediateFiles.push(currentPath);
    }
    currentPath = clipOutput;
  }

  if (subtitleEnabled) {
    const subtitleOutput = await localWorkPath(`task-subtitle-${source.id}`, extension);
    updateJobMessage(job.id, "去字幕处理中");
    await renderSubtitleToFile({
      jobId: job.id,
      inputPath: currentPath,
      outputPath: subtitleOutput,
      mode: subtitle.mode ?? "sttn-auto",
      areas: Array.isArray(subtitle.areas) ? subtitle.areas : [],
      baseProgress: cuts.length ? 45 : 0,
      spanProgress: cuts.length ? 54 : 99
    });
    if (currentPath !== inputPath) {
      intermediateFiles.push(currentPath);
    }
    currentPath = subtitleOutput;
  }

  ensureJobNotCancelled(job.id);
  const pendingOutput = await preparePendingJobOutput({
    source,
    outputPath: currentPath,
    jobId: job.id
  });

  for (const file of intermediateFiles) {
    await fs.rm(file, { force: true }).catch(() => undefined);
  }

  db.prepare(
    "update processing_jobs set status = 'completed', progress = 100, output_relative_path = ?, output_file_name = ?, completed_at = datetime('now'), message = '处理完成，等待确认入库' where id = ?"
  ).run(pendingOutput.relativePath, pendingOutput.fileName, job.id);
  appendJobLog(job.id, "处理完成，等待确认入库");
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (true) {
      const job = db
        .prepare("select * from processing_jobs where status = 'queued' order by id asc limit 1")
        .get() as ProcessingJobRow | undefined;
      if (!job) break;
      try {
        if (job.type === "video_process") {
          await runVideoProcessJob(job);
        } else if (job.type === "subtitle_remove") {
          await runSubtitleRemoveJob(job);
        } else {
          await runClipJob(job);
        }
      } catch (error) {
        const cancelled = (db.prepare("select cancel_requested from processing_jobs where id = ?").get(job.id) as { cancel_requested: number } | undefined)
          ?.cancel_requested;
        db.prepare("update processing_jobs set status = 'failed', message = ?, error = ?, completed_at = datetime('now') where id = ?").run(
          cancelled ? "已取消" : "处理失败",
          error instanceof Error ? error.message : String(error),
          job.id
        );
        if (cancelled) {
          markSourceVideoUnprocessed(job.source_video_id);
        }
        appendJobLog(job.id, `${cancelled ? "任务已取消" : "任务失败"}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    queueRunning = false;
  }
}

export async function registerRoutes(app: FastifyInstance) {
  reconcileProcessingVideoStatuses();
  void processQueue();

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/videos", async (request) => ({
    items: listVideos(request.query as Record<string, unknown>)
  }));

  app.post("/api/videos", async (request, reply) => {
    const body = z
      .object({
        library: userVideoLibrarySchema,
        relativePath: z.string().min(1),
        note: z.string().optional()
      })
      .parse(request.body);

    const rootDir = rootDirForLibrary(body.library);
    const fullPath = path.resolve(rootDir, body.relativePath);
    const status = statusForLibrary(body.library);

    if (!fullPath.startsWith(path.resolve(rootDir) + path.sep)) {
      return reply.code(400).send({ message: "Path must stay inside the configured library directory." });
    }

    const renamed = await renameFileForRule({ library: body.library, filePath: fullPath, status, platformNames: [] });
    const duration = await readDurationSeconds(renamed.fullPath);
    const result = db
      .prepare(
        `
        insert into videos (library, relative_path, file_name, file_size, duration_seconds, status, note, file_mtime_ms)
        values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(library, relative_path) do update set
          file_size = excluded.file_size,
          duration_seconds = excluded.duration_seconds,
          status = excluded.status,
          note = excluded.note,
          file_mtime_ms = excluded.file_mtime_ms
        `
      )
      .run(
        body.library,
        renamed.relativePath,
        renamed.fileName,
        renamed.fileSize,
        duration,
        status,
        body.note ?? "",
        renamed.fileMtimeMs
      );

    return reply.code(201).send({ id: Number(result.lastInsertRowid) || undefined });
  });

  app.post("/api/videos/upload", async (request, reply) => {
    const parts = request.parts();
    let library: Library = "unprocessed";
    let note = "";
    let lastModifiedMs: number | undefined;
    const platformIds: number[] = [];
    let tempUploadPath = "";
    let savedPath = "";
    let originalName = "";
    let tempUploadDir = "";

    for await (const part of parts) {
      if (part.type === "file") {
        if (part.fieldname !== "file") {
          await part.file.resume();
          continue;
        }

        originalName = sanitizeUploadFileName(part.filename);
        tempUploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-manager-upload-"));
        tempUploadPath = path.join(tempUploadDir, originalName);
        await pipeline(part.file, await fs.open(tempUploadPath, "w").then((handle) => handle.createWriteStream()));
      } else {
        const value = String(part.value ?? "");
        if (part.fieldname === "library") {
          library = userVideoLibrarySchema.parse(value);
        }
        if (part.fieldname === "note") {
          note = value;
        }
        if (part.fieldname === "lastModified") {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed > 0) {
            lastModifiedMs = parsed;
          }
        }
        if (part.fieldname === "platformIds") {
          const parsed = Number(value);
          if (Number.isInteger(parsed) && parsed > 0) {
            platformIds.push(parsed);
          }
        }
      }
    }

    if (!tempUploadPath) {
      return reply.code(400).send({ message: "No file uploaded." });
    }

    const finalStatus = statusForLibrary(library);
    const rootDir = rootDirForLibrary(library);
    await fs.mkdir(rootDir, { recursive: true });
    savedPath = await nextAvailablePath("", path.join(rootDir, originalName));

    try {
      await fs.copyFile(tempUploadPath, savedPath);
      await fs.rm(tempUploadDir, { recursive: true, force: true });

      if (lastModifiedMs) {
        const date = new Date(lastModifiedMs);
        await fs.utimes(savedPath, date, date);
      }

      const renamed = await renameFileForRule({ library, filePath: savedPath, status: finalStatus, platformNames: [] });
      const duration = await readDurationSeconds(renamed.fullPath);
      const result = db
        .prepare(
          `
          insert into videos (library, relative_path, file_name, file_size, duration_seconds, status, note, file_mtime_ms)
          values (?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(library, relative_path) do update set
            file_size = excluded.file_size,
            duration_seconds = excluded.duration_seconds,
            status = excluded.status,
            note = excluded.note,
            file_mtime_ms = excluded.file_mtime_ms
          `
        )
        .run(library, renamed.relativePath, renamed.fileName, renamed.fileSize, duration, finalStatus, note, renamed.fileMtimeMs);
      const videoId = Number(result.lastInsertRowid);

      if (library === "processed" && platformIds.length) {
        const publication = db.prepare(
          `
          insert into video_publications (video_id, platform_id)
          values (?, ?)
          on conflict(video_id, platform_id) do nothing
          `
        );
        for (const platformId of new Set(platformIds)) {
          publication.run(videoId, platformId);
        }
        await renameStoredVideo(videoId);
      }

      return reply.code(201).send({
        id: videoId || undefined,
        originalName,
        fileName: getVideo(videoId)?.file_name ?? renamed.fileName,
        relativePath: getVideo(videoId)?.relative_path ?? renamed.relativePath
      });
    } catch (error) {
      await fs.rm(tempUploadDir, { recursive: true, force: true }).catch(() => undefined);
      if (savedPath) {
        await fs.rm(savedPath, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  });

  app.patch("/api/videos/:id", async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const body = z
      .object({
        status: userVideoStatusSchema.optional(),
        note: z.string().optional()
      })
      .parse(request.body);

    if (body.status) {
      await moveStoredVideoToLibrary(id, body.status);
    }

    if (body.note !== undefined) {
      db.prepare("update videos set note = ? where id = ?").run(body.note, id);
    }

    return { ok: true };
  });

  app.get("/api/videos/:id/stream", async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const video = getVideo(id);

    if (!video) {
      return reply.code(404).send({ message: "Video not found." });
    }

    const filePath = fullPathForVideo(video);
    return sendVideoFile(reply, filePath, video.file_name, request.headers.range);
  });

  app.get("/api/videos/:id/download", async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const video = getVideo(id);

    if (!video) {
      return reply.code(404).send({ message: "Video not found." });
    }

    return sendVideoFile(reply, fullPathForVideo(video), video.file_name, request.headers.range, "attachment");
  });

  app.post("/api/videos/:id/clip", async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const video = getVideoRequired(id);
    if (video.status !== "unprocessed") {
      return reply.code(400).send({ message: "只有未处理视频可以添加处理任务。" });
    }
    const body = z
      .object({
        cuts: z.array(z.object({ start: z.number().nonnegative(), end: z.number().positive() })).min(1),
        mode: z.enum(["accurate", "lossless"]).default("accurate")
      })
      .parse(request.body);

    const result = db.transaction(() => {
      const inserted = db
        .prepare(
          `
          insert into processing_jobs (source_video_id, status, mode, cuts_json, message)
          values (?, 'queued', ?, ?, '等待剪辑')
          `
        )
        .run(id, body.mode, JSON.stringify(body.cuts));
      markSourceVideoProcessing(id);
      return inserted;
    })();

    void processQueue();
    return reply.code(202).send({ id: Number(result.lastInsertRowid) });
  });

  app.post("/api/videos/:id/subtitle-remove", async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const video = getVideoRequired(id);
    if (video.status !== "unprocessed") {
      return reply.code(400).send({ message: "只有未处理视频可以添加处理任务。" });
    }
    const body = z
      .object({
        mode: z.enum(["sttn-auto", "sttn-det", "lama", "propainter", "opencv"]).default("sttn-auto"),
        areas: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().positive(), z.number().int().nonnegative(), z.number().int().positive()])).default([])
      })
      .parse(request.body);

    const result = db.transaction(() => {
      const inserted = db
        .prepare(
          `
          insert into processing_jobs (source_video_id, type, status, mode, cuts_json, message)
          values (?, 'subtitle_remove', 'queued', ?, ?, '等待去字幕')
          `
        )
        .run(id, body.mode, JSON.stringify({ areas: body.areas }));
      markSourceVideoProcessing(id);
      return inserted;
    })();

    void processQueue();
    return reply.code(202).send({ id: Number(result.lastInsertRowid) });
  });

  app.post("/api/videos/:id/processing-task", async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const video = getVideoRequired(id);
    if (video.status !== "unprocessed") {
      return reply.code(400).send({ message: "只有未处理视频可以添加处理任务。" });
    }

    const body = z
      .object({
        cuts: z.array(z.object({ start: z.number().nonnegative(), end: z.number().positive() })).default([]),
        clipMode: z.enum(["accurate", "lossless"]).default("accurate"),
        subtitle: z
          .object({
            enabled: z.boolean().default(false),
            mode: z.enum(["sttn-auto", "sttn-det", "lama", "propainter", "opencv"]).default("sttn-auto"),
            areas: z
              .array(z.tuple([z.number().int().nonnegative(), z.number().int().positive(), z.number().int().nonnegative(), z.number().int().positive()]))
              .default([])
          })
          .default({ enabled: false, mode: "sttn-auto", areas: [] })
      })
      .parse(request.body);

    if (!body.cuts.length && !body.subtitle.enabled) {
      return reply.code(400).send({ message: "请至少配置剪辑或去字幕处理。" });
    }

    const result = db.transaction(() => {
      const inserted = db
        .prepare(
          `
          insert into processing_jobs (source_video_id, type, status, mode, cuts_json, message)
          values (?, 'video_process', 'queued', ?, ?, '等待处理')
          `
        )
        .run(id, body.clipMode, JSON.stringify(body));
      markSourceVideoProcessing(id);
      return inserted;
    })();

    void processQueue();
    return reply.code(202).send({ id: Number(result.lastInsertRowid) });
  });

  app.get("/api/processing-jobs", async () => ({
    items: db
      .prepare(
        `
        select
          j.*,
          sv.file_name as source_file_name,
          coalesce(ov.file_name, j.output_file_name) as output_file_name,
          ov.library as output_library
        from processing_jobs j
        left join videos sv on sv.id = j.source_video_id
        left join videos ov on ov.id = j.output_video_id
        order by j.id desc
        limit 100
        `
      )
      .all()
  }));

  app.get("/api/processing-jobs/:id", async (request) => {
    const id = parseId((request.params as { id: string }).id);
    return {
      item: db
        .prepare(
          `
          select
            j.*,
            sv.file_name as source_file_name,
            coalesce(ov.file_name, j.output_file_name) as output_file_name,
            ov.library as output_library
          from processing_jobs j
          left join videos sv on sv.id = j.source_video_id
          left join videos ov on ov.id = j.output_video_id
          where j.id = ?
          `
        )
        .get(id)
    };
  });

  app.get("/api/processing-jobs/:id/output-stream", async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const job = db.prepare("select * from processing_jobs where id = ?").get(id) as ProcessingJobRow | undefined;
    if (!job) {
      return reply.code(404).send({ message: "Job not found." });
    }

    if (job.output_video_id) {
      const outputVideo = getVideo(job.output_video_id);
      if (!outputVideo) {
        return reply.code(404).send({ message: "Output video not found." });
      }
      return sendVideoFile(reply, fullPathForVideo(outputVideo), outputVideo.file_name, request.headers.range);
    }

    if (!job.output_relative_path) {
      return reply.code(404).send({ message: "Job output not found." });
    }

    const outputPath = path.join(rootDirForLibrary("processing"), job.output_relative_path);
    const outputName = job.output_file_name || path.basename(outputPath);
    return sendVideoFile(reply, outputPath, outputName, request.headers.range);
  });

  app.post("/api/processing-jobs/:id/confirm", async (request) => {
    const id = parseId((request.params as { id: string }).id);
    const job = db.prepare("select * from processing_jobs where id = ?").get(id) as ProcessingJobRow | undefined;
    if (!job) {
      throw new Error("Job not found.");
    }
    if (job.status === "confirming") {
      return { ok: true, confirming: true };
    }
    if (job.status !== "completed" || (!job.output_video_id && !job.output_relative_path)) {
      throw new Error("任务还没有可确认的处理结果。");
    }

    db.prepare("update processing_jobs set status = 'confirming', message = '确认入库中', error = '' where id = ?").run(id);
    appendJobLog(id, "确认入库已加入后台执行");
    void runConfirmJob(id);
    return { ok: true, confirming: true };
  });

  app.post("/api/processing-jobs/:id/cancel", async (request) => {
    const id = parseId((request.params as { id: string }).id);
    const job = db.prepare("select * from processing_jobs where id = ?").get(id) as ProcessingJobRow | undefined;
    if (!job) {
      throw new Error("Job not found.");
    }
    const hasPendingOutput = job.status === "completed" && !job.output_video_id && Boolean(job.output_relative_path);
    if (job.status !== "queued" && job.status !== "running" && job.status !== "confirming" && job.status !== "failed" && !hasPendingOutput) {
      throw new Error("只能取消等待中、处理中、失败或待确认的任务。");
    }

    if (job.output_relative_path) {
      await fs.rm(path.join(rootDirForLibrary("processing"), job.output_relative_path), { force: true }).catch(() => undefined);
    }

    db.prepare(
      `
      update processing_jobs
      set status = 'failed',
          progress = 0,
          cancel_requested = 1,
          message = '已取消',
          error = '已取消',
          output_relative_path = null,
          output_file_name = null,
          completed_at = datetime('now')
      where id = ?
      `
    ).run(id);
    markSourceVideoUnprocessed(job.source_video_id);
    appendJobLog(id, "用户取消任务");
    activeFfmpegProcesses.get(id)?.kill("SIGTERM");
    return { ok: true };
  });

  app.delete("/api/videos/:id", async (request) => {
    const id = parseId((request.params as { id: string }).id);
    const activeJobs = db
      .prepare("select id from processing_jobs where source_video_id = ? and status in ('queued', 'running')")
      .all(id) as Array<{ id: number }>;

    for (const job of activeJobs) {
      db.prepare(
        `
        update processing_jobs
        set cancel_requested = 1,
            status = 'failed',
            message = '源视频已删除',
            error = '源视频已删除',
            completed_at = datetime('now')
        where id = ?
        `
      ).run(job.id);
      activeFfmpegProcesses.get(job.id)?.kill("SIGTERM");
      appendJobLog(job.id, "源视频已删除，任务取消");
    }

    await deleteStoredVideo(id);
    return { ok: true };
  });

  app.post("/api/scans/run", async () => {
    const results = [await scanLibrary("unprocessed"), await scanLibrary("archived"), await scanLibrary("processed")];
    return { results };
  });

  app.get("/api/platforms", async () => ({
    items: db.prepare("select * from platforms order by enabled desc, sort_order asc, name asc").all() as PlatformRow[]
  }));

  app.post("/api/platforms", async (request, reply) => {
    const body = z.object({ name: z.string().trim().min(1), sortOrder: z.number().int().optional() }).parse(request.body);
    const result = db
      .prepare("insert into platforms (name, sort_order) values (?, ?) on conflict(name) do update set enabled = 1")
      .run(body.name, body.sortOrder ?? 100);
    return reply.code(201).send({ id: Number(result.lastInsertRowid) || undefined });
  });

  app.patch("/api/platforms/:id", async (request) => {
    const id = parseId((request.params as { id: string }).id);
    const body = z
      .object({
        name: z.string().trim().min(1).optional(),
        enabled: z.boolean().optional(),
        sortOrder: z.number().int().optional()
      })
      .parse(request.body);

    const affectedVideoIds = getVideoIdsForPlatform(id);

    db.prepare(
      `
      update platforms
      set
        name = coalesce(@name, name),
        enabled = coalesce(@enabled, enabled),
        sort_order = coalesce(@sortOrder, sort_order)
      where id = @id
      `
    ).run({
      id,
      name: body.name ?? null,
      enabled: body.enabled === undefined ? null : body.enabled ? 1 : 0,
      sortOrder: body.sortOrder ?? null
    });

    if (body.name) {
      for (const videoId of affectedVideoIds) {
        await renameStoredVideo(videoId);
      }
    }

    return { ok: true };
  });

  app.delete("/api/platforms/:id", async (request) => {
    const id = parseId((request.params as { id: string }).id);
    const affectedVideoIds = getVideoIdsForPlatform(id);

    db.prepare("delete from platforms where id = ?").run(id);

    for (const videoId of affectedVideoIds) {
      await renameStoredVideo(videoId);
    }

    return { ok: true };
  });

  app.post("/api/videos/:id/publications", async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const body = z.object({ platformId: z.number().int().positive(), note: z.string().optional() }).parse(request.body);
    db.prepare(
      `
      insert into video_publications (video_id, platform_id, note)
      values (?, ?, ?)
      on conflict(video_id, platform_id) do update set note = excluded.note
      `
    ).run(id, body.platformId, body.note ?? "");
    await renameStoredVideo(id);
    return reply.code(201).send({ ok: true });
  });

  app.delete("/api/videos/:id/publications/:platformId", async (request) => {
    const params = request.params as { id: string; platformId: string };
    const id = parseId(params.id);
    const platformId = parseId(params.platformId);
    db.prepare("delete from video_publications where video_id = ? and platform_id = ?").run(id, platformId);
    await renameStoredVideo(id);
    return { ok: true };
  });
}
