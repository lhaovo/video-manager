export type Library = "unprocessed" | "processing" | "archived" | "processed";
export type Status = "unprocessed" | "processing" | "archived" | "processed";

export type VideoRow = {
  id: number;
  library: Library;
  relative_path: string;
  file_name: string;
  file_size: number;
  duration_seconds: number;
  status: Status;
  note: string;
  file_mtime_ms: number | null;
  created_at: string;
  updated_at: string;
  publication_platforms: string | null;
  publication_platform_ids: string | null;
};

export type PlatformRow = {
  id: number;
  name: string;
  enabled: 0 | 1;
  sort_order: number;
  created_at: string;
  updated_at: string;
};
