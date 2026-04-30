import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Library } from "./types.js";

const videoExtensions = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

export function isVideoFile(filePath: string) {
  return videoExtensions.has(path.extname(filePath).toLowerCase());
}

export async function readDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ]);

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.on("error", () => resolve(0));
    child.on("close", () => {
      const value = Number.parseFloat(stdout.trim());
      resolve(Number.isFinite(value) ? value : 0);
    });
  });
}

export async function* walkVideoFiles(rootDir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkVideoFiles(fullPath);
    } else if (entry.isFile() && isVideoFile(fullPath)) {
      yield fullPath;
    }
  }
}

export function toRelativePath(rootDir: string, filePath: string) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

export function statusForLibrary(library: Library) {
  return library;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function formatFileDate(ms: number) {
  const date = new Date(ms);
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "_" + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
}

export function sanitizeFileNamePart(value: string) {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._ ]+|[._ ]+$/g, "")
      .slice(0, 80) || "unknown"
  );
}

export async function nextAvailablePath(currentPath: string, desiredPath: string) {
  if (currentPath === desiredPath) {
    return desiredPath;
  }

  const parsed = path.parse(desiredPath);
  let candidate = desiredPath;
  let index = 2;

  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(parsed.dir, `${parsed.name}_${index}${parsed.ext}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
}

export function buildManagedFileName(mtimeMs: number, extension: string, status: "unprocessed" | "processing" | "archived" | "processed", platformNames: string[]) {
  const datePart = formatFileDate(mtimeMs);
  const safePlatforms = status === "processed" ? platformNames.map(sanitizeFileNamePart).filter(Boolean) : [];
  const stem = [datePart, ...safePlatforms].join("_");
  return `${stem}${extension}`;
}
