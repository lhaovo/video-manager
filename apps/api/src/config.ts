import "dotenv/config";
import path from "node:path";

const rootDir = path.resolve(new URL("../../..", import.meta.url).pathname);

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3001),
  databasePath: path.resolve(rootDir, process.env.DATABASE_PATH ?? "data/video-manager.db"),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  vsrApiUrl: process.env.VSR_API_URL ?? "http://127.0.0.1:8000",
  videoDirs: {
    unprocessed: process.env.VIDEO_UNPROCESSED_DIR ?? "/mnt/video-manager/unprocessed",
    processing: process.env.VIDEO_PROCESSING_DIR ?? "/mnt/video-manager/processing",
    archived: process.env.VIDEO_ARCHIVED_DIR ?? "/mnt/video-manager/archived",
    processed: process.env.VIDEO_PROCESSED_DIR ?? "/mnt/video-manager/processed"
  }
} as const;

export type Library = keyof typeof config.videoDirs;
