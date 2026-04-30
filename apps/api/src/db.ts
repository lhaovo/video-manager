import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function migrateVideosTableForProcessing() {
  const table = db
    .prepare("select sql from sqlite_master where type = 'table' and name = 'videos'")
    .get() as { sql: string } | undefined;

  if (!table || table.sql.includes("'processing'")) {
    return;
  }

  db.pragma("foreign_keys = OFF");
  const migrate = db.transaction(() => {
    db.exec(`
      drop trigger if exists videos_updated_at;
      create table videos_new (
        id integer primary key autoincrement,
        library text not null check (library in ('unprocessed', 'processing', 'processed')),
        relative_path text not null,
        file_name text not null,
        file_size integer not null,
        duration_seconds real not null default 0,
        status text not null check (status in ('unprocessed', 'processing', 'processed')),
        note text not null default '',
        file_mtime_ms integer,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now')),
        unique(library, relative_path)
      );
      insert into videos_new (
        id, library, relative_path, file_name, file_size, duration_seconds, status, note, file_mtime_ms, created_at, updated_at
      )
      select
        id, library, relative_path, file_name, file_size, duration_seconds, status, note, file_mtime_ms, created_at, updated_at
      from videos;
      drop table videos;
      alter table videos_new rename to videos;
    `);
  });
  migrate();
  db.pragma("foreign_keys = ON");
}

function migrateVideosTableForArchive() {
  const table = db
    .prepare("select sql from sqlite_master where type = 'table' and name = 'videos'")
    .get() as { sql: string } | undefined;

  if (!table || table.sql.includes("'archived'")) {
    return;
  }

  db.pragma("foreign_keys = OFF");
  const migrate = db.transaction(() => {
    db.exec(`
      drop trigger if exists videos_updated_at;
      create table videos_new (
        id integer primary key autoincrement,
        library text not null check (library in ('unprocessed', 'processing', 'archived', 'processed')),
        relative_path text not null,
        file_name text not null,
        file_size integer not null,
        duration_seconds real not null default 0,
        status text not null check (status in ('unprocessed', 'processing', 'archived', 'processed')),
        note text not null default '',
        file_mtime_ms integer,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now')),
        unique(library, relative_path)
      );
      insert into videos_new (
        id, library, relative_path, file_name, file_size, duration_seconds, status, note, file_mtime_ms, created_at, updated_at
      )
      select
        id, library, relative_path, file_name, file_size, duration_seconds, status, note, file_mtime_ms, created_at, updated_at
      from videos;
      drop table videos;
      alter table videos_new rename to videos;
    `);
  });
  migrate();
  db.pragma("foreign_keys = ON");
}

function ensureProcessingJobColumns() {
  const columns = db
    .prepare("pragma table_info(processing_jobs)")
    .all()
    .map((row) => (row as { name: string }).name);

  if (!columns.includes("output_relative_path")) {
    db.exec("alter table processing_jobs add column output_relative_path text");
  }
  if (!columns.includes("output_file_name")) {
    db.exec("alter table processing_jobs add column output_file_name text");
  }
  if (!columns.includes("cancel_requested")) {
    db.exec("alter table processing_jobs add column cancel_requested integer not null default 0");
  }
  if (!columns.includes("log_json")) {
    db.exec("alter table processing_jobs add column log_json text not null default '[]'");
  }
}

function migrateProcessingJobsForConfirming() {
  const table = db
    .prepare("select sql from sqlite_master where type = 'table' and name = 'processing_jobs'")
    .get() as { sql: string } | undefined;

  if (!table || table.sql.includes("'confirming'")) {
    return;
  }

  db.pragma("foreign_keys = OFF");
  const migrate = db.transaction(() => {
    db.exec(`
      drop trigger if exists processing_jobs_updated_at;
      create table processing_jobs_new (
        id integer primary key autoincrement,
        source_video_id integer not null references videos(id) on delete cascade,
        output_video_id integer references videos(id) on delete set null,
        type text not null default 'clip',
        status text not null check (status in ('queued', 'running', 'completed', 'confirming', 'failed')),
        progress real not null default 0,
        mode text not null default 'accurate',
        cuts_json text not null default '[]',
        message text not null default '',
        error text not null default '',
        created_at text not null default (datetime('now')),
        started_at text,
        completed_at text,
        updated_at text not null default (datetime('now')),
        output_relative_path text,
        output_file_name text,
        cancel_requested integer not null default 0,
        log_json text not null default '[]'
      );
      insert into processing_jobs_new (
        id, source_video_id, output_video_id, type, status, progress, mode, cuts_json, message, error,
        created_at, started_at, completed_at, updated_at, output_relative_path, output_file_name, cancel_requested, log_json
      )
      select
        id, source_video_id, output_video_id, type, status, progress, mode, cuts_json, message, error,
        created_at, started_at, completed_at, updated_at, output_relative_path, output_file_name, cancel_requested, log_json
      from processing_jobs;
      drop table processing_jobs;
      alter table processing_jobs_new rename to processing_jobs;
    `);
  });
  migrate();
  db.pragma("foreign_keys = ON");
}

export function migrate() {
  db.exec(`
    create table if not exists videos (
      id integer primary key autoincrement,
      library text not null check (library in ('unprocessed', 'processing', 'archived', 'processed')),
      relative_path text not null,
      file_name text not null,
      file_size integer not null,
      duration_seconds real not null default 0,
      status text not null check (status in ('unprocessed', 'processing', 'archived', 'processed')),
      note text not null default '',
      file_mtime_ms integer,
      created_at text not null default (datetime('now')),
      updated_at text not null default (datetime('now')),
      unique(library, relative_path)
    );

    create table if not exists platforms (
      id integer primary key autoincrement,
      name text not null unique,
      enabled integer not null default 1,
      sort_order integer not null default 0,
      created_at text not null default (datetime('now')),
      updated_at text not null default (datetime('now'))
    );

    create table if not exists video_publications (
      id integer primary key autoincrement,
      video_id integer not null references videos(id) on delete cascade,
      platform_id integer not null references platforms(id) on delete cascade,
      published_at text not null default (datetime('now')),
      note text not null default '',
      created_at text not null default (datetime('now')),
      updated_at text not null default (datetime('now')),
      unique(video_id, platform_id)
    );

    create table if not exists app_settings (
      key text primary key,
      value text not null,
      updated_at text not null default (datetime('now'))
    );

    create table if not exists processing_jobs (
      id integer primary key autoincrement,
      source_video_id integer not null references videos(id) on delete cascade,
      output_video_id integer references videos(id) on delete set null,
      type text not null default 'clip',
      status text not null check (status in ('queued', 'running', 'completed', 'confirming', 'failed')),
      progress real not null default 0,
      mode text not null default 'accurate',
      cuts_json text not null default '[]',
      message text not null default '',
      error text not null default '',
      created_at text not null default (datetime('now')),
      started_at text,
      completed_at text,
      updated_at text not null default (datetime('now'))
    );

    create trigger if not exists videos_updated_at
    after update on videos
    begin
      update videos set updated_at = datetime('now') where id = new.id;
    end;

    create trigger if not exists platforms_updated_at
    after update on platforms
    begin
      update platforms set updated_at = datetime('now') where id = new.id;
    end;

    create trigger if not exists video_publications_updated_at
    after update on video_publications
    begin
      update video_publications set updated_at = datetime('now') where id = new.id;
    end;

    create trigger if not exists processing_jobs_updated_at
    after update on processing_jobs
    begin
      update processing_jobs set updated_at = datetime('now') where id = new.id;
    end;
  `);

  migrateVideosTableForProcessing();
  migrateVideosTableForArchive();
  ensureProcessingJobColumns();
  migrateProcessingJobsForConfirming();

  db.exec(`
    create trigger if not exists videos_updated_at
    after update on videos
    begin
      update videos set updated_at = datetime('now') where id = new.id;
    end;
  `);

  const seeded = db
    .prepare("select value from app_settings where key = 'default_platforms_seeded'")
    .get() as { value: string } | undefined;

  if (!seeded) {
    const platformCount = (db.prepare("select count(*) as count from platforms").get() as { count: number }).count;

    if (platformCount === 0) {
      const seed = db.prepare(`
        insert into platforms (name, enabled, sort_order)
        values (?, 1, ?)
        on conflict(name) do nothing
      `);

      ["TikTok", "YouTube", "Instagram", "Facebook", "X", "Pinterest"].forEach((name, index) => {
        seed.run(name, index + 1);
      });
    }

    db.prepare(
      `
      insert into app_settings (key, value)
      values ('default_platforms_seeded', 'true')
      on conflict(key) do update set value = excluded.value, updated_at = datetime('now')
      `
    ).run();
  }
}
