import { Check, Clapperboard, Database, Download, Eye, FileText, History, Plus, RefreshCw, Search, Settings, Trash2, X } from "lucide-react";
import { FormEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";

type Video = {
  id: number;
  library: "unprocessed" | "processing" | "archived" | "processed";
  relative_path: string;
  file_name: string;
  file_size: number;
  duration_seconds: number;
  status: "unprocessed" | "processing" | "archived" | "processed";
  note: string;
  created_at: string;
  publication_platforms: string | null;
  publication_platform_ids: string | null;
};

type PreviewTarget = {
  title: string;
  subtitle: string;
  src: string;
};

type Platform = {
  id: number;
  name: string;
  enabled: 0 | 1;
  sort_order: number;
};

type ProcessingJob = {
  id: number;
  source_video_id: number;
  output_video_id: number | null;
  type: "clip" | "subtitle_remove" | "video_process";
  status: "queued" | "running" | "completed" | "confirming" | "failed";
  progress: number;
  mode: string;
  cuts_json: string;
  message: string;
  error: string;
  created_at: string;
  source_file_name: string | null;
  output_file_name: string | null;
  output_relative_path: string | null;
  output_library: "unprocessed" | "processing" | "archived" | "processed" | null;
  cancel_requested: number;
  log_json: string;
};

const statusLabels = {
  unprocessed: "未处理",
  processing: "处理中",
  archived: "原视频归档",
  processed: "已处理"
};

const nextStatusByStatus = {
  unprocessed: "processed",
  processing: "unprocessed",
  archived: "unprocessed",
  processed: "unprocessed"
} as const;

function isUnresolvedJob(job: ProcessingJob) {
  return (
    job.cancel_requested !== 1 &&
    (job.status === "queued" ||
      job.status === "running" ||
      job.status === "confirming" ||
      job.status === "failed" ||
      (job.status === "completed" && !job.output_video_id && Boolean(job.output_relative_path)))
  );
}

function formatDuration(seconds: number) {
  const total = Math.round(seconds || 0);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (typeof options?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...options,
    headers
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

export function App() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [videosLoading, setVideosLoading] = useState(false);
  const [status, setStatus] = useState<"unprocessed" | "processing" | "archived" | "processed">("unprocessed");
  const [duration, setDuration] = useState("all");
  const [platform, setPlatform] = useState("all");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showPlatforms, setShowPlatforms] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  const [batchVideo, setBatchVideo] = useState<Video | null>(null);
  const [descriptionVideo, setDescriptionVideo] = useState<Video | null>(null);
  const [taskVideo, setTaskVideo] = useState<Video | null>(null);
  const [logJob, setLogJob] = useState<ProcessingJob | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);

  const enabledPlatforms = useMemo(() => platforms.filter((item) => item.enabled), [platforms]);
  const activeProcessingVideoIds = useMemo(
    () => new Set(jobs.filter((job) => isUnresolvedJob(job)).map((job) => job.source_video_id)),
    [jobs]
  );
  const filtersRef = useRef({ status, duration, platform, search });
  const dataRequestSeq = useRef(0);

  useEffect(() => {
    filtersRef.current = { status, duration, platform, search };
  }, [status, duration, platform, search]);

  useEffect(() => {
    if (status !== "processed" && platform !== "all") {
      setPlatform("all");
    }
  }, [status, platform]);

  async function loadData(filters = filtersRef.current, options: { clear?: boolean; silent?: boolean } = {}) {
    const requestId = ++dataRequestSeq.current;
    if (!options.silent) {
      setVideosLoading(true);
    }
    if (options.clear) {
      setVideos([]);
    }
    const params = new URLSearchParams(filters);
    try {
      const [videoResult, platformResult] = await Promise.all([
        requestJson<{ items: Video[] }>(`/api/videos?${params}`),
        requestJson<{ items: Platform[] }>("/api/platforms")
      ]);
      if (requestId !== dataRequestSeq.current) return;
      setVideos(videoResult.items);
      setPlatforms(platformResult.items);
    } finally {
      if (requestId === dataRequestSeq.current && !options.silent) {
        setVideosLoading(false);
      }
    }
  }

  useEffect(() => {
    loadData({ status, duration, platform, search }, { clear: true }).catch((error) => setMessage(error.message));
  }, [status, duration, platform, search]);

  async function loadJobs() {
    const result = await requestJson<{ items: ProcessingJob[] }>("/api/processing-jobs");
    setJobs(result.items);
    return result.items;
  }

  useEffect(() => {
    loadJobs().catch(() => undefined);
    const timer = window.setInterval(() => {
      loadJobs()
        .then((items) => {
          if (items.some((item) => item.status === "running" || item.status === "queued")) {
            loadData(filtersRef.current, { silent: true }).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  async function runScan() {
    setLoading(true);
    setMessage("正在扫描视频目录...");
    try {
      const result = await requestJson<{ results: Array<{ library: string; insertedCount: number; skippedCount: number; deletedCount: number }> }>(
        "/api/scans/run",
        { method: "POST" }
      );
      const inserted = result.results.reduce((sum, item) => sum + item.insertedCount, 0);
      const skipped = result.results.reduce((sum, item) => sum + item.skippedCount, 0);
      const deleted = result.results.reduce((sum, item) => sum + item.deletedCount, 0);
      setMessage(`扫描完成：新增 ${inserted} 个，跳过 ${skipped} 个，清理 ${deleted} 个失效记录。`);
      await loadData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "扫描失败");
    } finally {
      setLoading(false);
    }
  }

  async function updateVideo(id: number, body: Partial<Pick<Video, "status" | "note">>) {
    await requestJson(`/api/videos/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    await loadData();
  }

  async function deleteVideo(id: number) {
    await requestJson(`/api/videos/${id}`, { method: "DELETE" });
    await loadData();
  }

  async function togglePublication(video: Video, platformId: number) {
    const publishedIds = new Set((video.publication_platform_ids ?? "").split(",").filter(Boolean).map(Number));
    if (publishedIds.has(platformId)) {
      await requestJson(`/api/videos/${video.id}/publications/${platformId}`, { method: "DELETE" });
    } else {
      await requestJson(`/api/videos/${video.id}/publications`, {
        method: "POST",
        body: JSON.stringify({ platformId })
      });
    }
    await loadData();
  }

  function publishedIdSet(video: Video) {
    return new Set((video.publication_platform_ids ?? "").split(",").filter(Boolean).map(Number));
  }

  async function addAllPlatforms(video: Video) {
    const publishedIds = publishedIdSet(video);
    const missingPlatforms = enabledPlatforms.filter((item) => !publishedIds.has(item.id));
    if (!missingPlatforms.length) {
      setMessage("该视频已添加所有启用平台。");
      return;
    }

    setLoading(true);
    setMessage(`正在给 ${video.file_name} 添加所有平台...`);
    try {
      for (const item of missingPlatforms) {
        await requestJson(`/api/videos/${video.id}/publications`, {
          method: "POST",
          body: JSON.stringify({ platformId: item.id })
        });
      }
      setMessage("全选添加完成。");
      await loadData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "全选添加失败");
    } finally {
      setLoading(false);
    }
  }

  async function invertPlatforms(video: Video) {
    const publishedIds = publishedIdSet(video);
    if (!enabledPlatforms.length) {
      setMessage("没有可用平台。");
      return;
    }

    setLoading(true);
    setMessage(`正在反选 ${video.file_name} 的发布平台...`);
    try {
      for (const item of enabledPlatforms) {
        if (publishedIds.has(item.id)) {
          await requestJson(`/api/videos/${video.id}/publications/${item.id}`, { method: "DELETE" });
        } else {
          await requestJson(`/api/videos/${video.id}/publications`, {
            method: "POST",
            body: JSON.stringify({ platformId: item.id })
          });
        }
      }
      setMessage("反选完成。");
      await loadData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "反选失败");
    } finally {
      setLoading(false);
    }
  }

  async function addSelectedPlatforms(video: Video, platformIds: number[]) {
    if (!platformIds.length) {
      setMessage("请选择要添加的平台。");
      return;
    }

    setLoading(true);
    setMessage(`正在给 ${video.file_name} 添加 ${platformIds.length} 个发布平台...`);
    try {
      for (const platformId of platformIds) {
        await requestJson(`/api/videos/${video.id}/publications`, {
          method: "POST",
          body: JSON.stringify({ platformId })
        });
      }
      setBatchVideo(null);
      setMessage("批量添加完成。");
      await loadData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量添加失败");
    } finally {
      setLoading(false);
    }
  }

  async function confirmJob(job: ProcessingJob) {
    setLoading(true);
    setMessage("正在提交确认入库...");
    try {
      await requestJson(`/api/processing-jobs/${job.id}/confirm`, { method: "POST" });
      setMessage("确认入库已开始，可继续其他操作。");
      await Promise.all([loadJobs(), loadData()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "确认失败");
    } finally {
      setLoading(false);
    }
  }

  async function cancelJob(job: ProcessingJob) {
    const action = job.status === "failed" ? "退回未处理列表" : "取消这个处理任务";
    if (!window.confirm(`${action}？原视频会回到未处理列表。`)) return;
    setLoading(true);
    setMessage(job.status === "failed" ? "正在退回未处理列表..." : "正在取消处理任务...");
    try {
      await requestJson(`/api/processing-jobs/${job.id}/cancel`, { method: "POST" });
      setMessage(job.status === "failed" ? "已退回未处理列表。" : "处理任务已取消。");
      await Promise.all([loadJobs(), loadData()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "取消失败");
    } finally {
      setLoading(false);
    }
  }

  function processingJobForVideo(video: Video) {
    return jobs.find(
      (job) =>
        job.source_video_id === video.id &&
        isUnresolvedJob(job)
    );
  }

  function previewTargetForVideo(video: Video, job?: ProcessingJob): PreviewTarget {
    if (job?.status === "completed" && (job.output_video_id || job.output_relative_path)) {
      return {
        title: "处理结果预览",
        subtitle: job.output_file_name || video.file_name,
        src: `/api/processing-jobs/${job.id}/output-stream`
      };
    }
    return {
      title: "视频预览",
      subtitle: video.file_name,
      src: `/api/videos/${video.id}/stream`
    };
  }

  const pageTitle = statusLabels[status];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-title">
          <h1>视频管理</h1>
          <p>处理队列与发布记录</p>
        </div>
        <nav className="side-nav">
          {(["unprocessed", "processing", "archived", "processed"] as const).map((item) => (
            <button key={item} className={status === item ? "side-nav-item active" : "side-nav-item"} onClick={() => setStatus(item)}>
              <span>{statusLabels[item]}</span>
            </button>
          ))}
        </nav>
        <div className="side-actions">
          <button className="secondary-button" onClick={runScan} disabled={loading}>
            <RefreshCw size={17} />
            扫描
          </button>
          <button className="secondary-button" onClick={() => setShowPlatforms(true)}>
            <Settings size={17} />
            平台
          </button>
          <button className="secondary-button" onClick={() => setShowHistory(true)}>
            <History size={17} />
            历史
          </button>
        </div>
      </aside>

      <section className="content-shell">
        <header className="content-header">
          <div>
            <h2>{pageTitle}</h2>
            <p>
              {status === "unprocessed" && "配置处理任务并加入队列。"}
              {status === "processing" && "查看处理进度、日志，或取消任务。"}
              {status === "archived" && "查看已产生处理结果的原视频，可移回未处理重新加工。"}
              {status === "processed" && "查看发布平台并维护发布标记。"}
            </p>
          </div>
          {(status === "unprocessed" || status === "processed") && (
            <button className="primary-button" onClick={() => setShowAdd(true)}>
              <Plus size={17} />
              {status === "processed" ? "上传已处理" : "上传未处理"}
            </button>
          )}
        </header>

        <section className="filters">
          <label>
            时长
            <select value={duration} onChange={(event) => setDuration(event.target.value)}>
              <option value="all">全部</option>
              <option value="lt_1m">小于 1 分钟</option>
              <option value="1_5m">1 到 5 分钟</option>
              <option value="5_15m">5 到 15 分钟</option>
              <option value="gte_15m">15 分钟以上</option>
            </select>
          </label>
          {status === "processed" && (
            <label>
              发布
              <select value={platform} onChange={(event) => setPlatform(event.target.value)}>
                <option value="all">全部</option>
                <option value="unpublished">未发布</option>
                {enabledPlatforms.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="search-field">
            文件名
            <span>
              <Search size={17} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名" />
            </span>
          </label>
        </section>

        {message && <div className="status-message">{message}</div>}

        <main className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>文件名</th>
              <th>时长</th>
              <th>大小</th>
              <th>状态</th>
              {status === "processed" && <th>已发布平台</th>}
              {status === "processing" && <th>处理日志</th>}
              <th>添加时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {videosLoading && !videos.length && (
              <tr>
                <td colSpan={status === "unprocessed" ? 6 : 7}>
                  <div className="empty-state compact-state">
                    <RefreshCw size={24} />
                    <span>正在加载...</span>
                  </div>
                </td>
              </tr>
            )}
            {videos.map((video) => {
              const publishedIds = publishedIdSet(video);
              const job = processingJobForVideo(video);
              const displayStatus = video.status === "unprocessed" && (activeProcessingVideoIds.has(video.id) || job) ? "processing" : video.status;
              return (
                <tr key={video.id}>
                  <td>
                    <div className="file-name">{video.file_name}</div>
                    <div className="file-path">{video.library}/{video.relative_path}</div>
                  </td>
                  <td>{formatDuration(video.duration_seconds)}</td>
                  <td>{formatSize(video.file_size)}</td>
                  <td>
                    <button
                      className={`status-pill ${displayStatus}`}
                      onClick={() => updateVideo(video.id, { status: nextStatusByStatus[video.status] })}
                      disabled={displayStatus === "processing"}
                    >
                      {statusLabels[displayStatus]}
                    </button>
                  </td>
                  {status === "processed" && (
                    <td>
                    <div className="platform-cell">
                      <div className="platform-tools">
                        <button className="mini-button" onClick={() => addAllPlatforms(video)} disabled={loading || !enabledPlatforms.length}>
                          全选
                        </button>
                        <button className="mini-button" onClick={() => invertPlatforms(video)} disabled={loading || !enabledPlatforms.length}>
                          反选
                        </button>
                        <button className="mini-button primary-mini" onClick={() => setBatchVideo(video)} disabled={loading || !enabledPlatforms.length}>
                          批量添加
                        </button>
                      </div>
                      <div className="platform-grid">
                        {enabledPlatforms.map((item) => {
                          const published = publishedIds.has(item.id);
                          return (
                            <button
                              key={item.id}
                              className={published ? "platform-tag active" : "platform-tag"}
                              onClick={() => togglePublication(video, item.id)}
                            >
                              {published ? <Check size={14} /> : <Plus size={14} />}
                              {item.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    </td>
                  )}
                  {status === "processing" && (
                    <td>
                      {job ? (
                        <div className="inline-job">
                          <strong>{job.status} {Math.round(job.progress)}%</strong>
                          <span>{job.message || job.error || "等待处理"}</span>
                          <div className="progress-track compact">
                            <span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
                          </div>
                        </div>
                      ) : (
                        <span className="file-path">暂无任务日志</span>
                      )}
                    </td>
                  )}
                  <td>{video.created_at}</td>
                  <td>
                    <div className="row-actions">
                      <button className="plain-button" onClick={() => setPreviewTarget(previewTargetForVideo(video, job))} title="预览视频">
                        <Eye size={17} />
                      </button>
                      <a className="plain-button" href={`/api/videos/${video.id}/download`} title="下载视频">
                        <Download size={17} />
                      </a>
                      {status === "processed" && (
                        <button className="plain-button" onClick={() => setDescriptionVideo(video)} title="描述信息">
                          <FileText size={17} />
                        </button>
                      )}
                      {status === "unprocessed" && (
                        <button className="plain-button" onClick={() => setTaskVideo(video)} title="添加处理任务" disabled={displayStatus !== "unprocessed"}>
                          <Clapperboard size={17} />
                        </button>
                      )}
                      {status === "archived" && (
                        <button className="secondary-button" onClick={() => updateVideo(video.id, { status: "unprocessed" })} disabled={loading}>
                          移回未处理
                        </button>
                      )}
                      {status === "processing" && job?.status === "completed" && (
                        <button className="primary-button" onClick={() => confirmJob(job)} disabled={loading}>
                          确认入库
                        </button>
                      )}
                      {status === "processing" && job?.status === "confirming" && (
                        <button className="secondary-button" disabled>
                          确认中
                        </button>
                      )}
                      {status === "processing" && job && (
                        <button className="secondary-button" onClick={() => setLogJob(job)}>
                          日志
                        </button>
                      )}
                      {status === "processing" && job && isUnresolvedJob(job) && (
                        <button className="danger-button" onClick={() => cancelJob(job)} title={job.status === "failed" ? "退回未处理" : "取消处理"}>
                          <X size={17} />
                        </button>
                      )}
                      <button className="danger-button" onClick={() => deleteVideo(video.id)} title="删除入库记录">
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!videosLoading && !videos.length && (
              <tr>
                <td colSpan={status === "unprocessed" ? 6 : 7}>
                  <div className="empty-state">
                    <Database size={28} />
                    <span>暂无视频记录</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </main>
      </section>

      {showAdd && (status === "unprocessed" || status === "processed") && (
        <AddVideoDialog targetLibrary={status} platforms={enabledPlatforms} onClose={() => setShowAdd(false)} onSaved={loadData} />
      )}
      {showPlatforms && (
        <PlatformDialog
          platforms={platforms}
          onClose={() => setShowPlatforms(false)}
          onSaved={loadData}
          onDeleted={(deletedId) => {
            if (platform === String(deletedId)) {
              setPlatform("all");
            }
          }}
        />
      )}
      {previewTarget && <PreviewDialog target={previewTarget} onClose={() => setPreviewTarget(null)} />}
      {taskVideo && (
        <TaskConfigDialog
          video={taskVideo}
          onClose={() => setTaskVideo(null)}
          onCreated={async () => {
            await loadJobs();
            setStatus("processing");
            setMessage("处理任务已加入队列。");
          }}
        />
      )}
      {showHistory && <JobHistoryDialog jobs={jobs} loading={loading} onClose={() => setShowHistory(false)} onConfirm={confirmJob} />}
      {logJob && <JobLogDialog job={jobs.find((item) => item.id === logJob.id) ?? logJob} onClose={() => setLogJob(null)} />}
      {descriptionVideo && (
        <DescriptionDialog
          video={descriptionVideo}
          onClose={() => setDescriptionVideo(null)}
          onSave={async (note) => {
            await updateVideo(descriptionVideo.id, { note });
            setDescriptionVideo(null);
            setMessage("描述信息已保存。");
          }}
        />
      )}
      {batchVideo && (
        <BatchPlatformDialog
          video={batchVideo}
          platforms={enabledPlatforms}
          publishedIds={publishedIdSet(batchVideo)}
          loading={loading}
          onClose={() => setBatchVideo(null)}
          onConfirm={(platformIds) => addSelectedPlatforms(batchVideo, platformIds)}
        />
      )}
    </div>
  );
}

function DescriptionDialog({
  video,
  onClose,
  onSave
}: {
  video: Video;
  onClose: () => void;
  onSave: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState(video.note ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await onSave(note);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal description-modal" onSubmit={submit}>
        <div className="modal-title">
          <div>
            <h2>描述信息</h2>
            <p className="modal-subtitle">{video.file_name}</p>
          </div>
          <button type="button" onClick={onClose} className="plain-button">
            <X size={18} />
          </button>
        </div>
        <label>
          描述
          <textarea className="description-textarea" value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? "保存中" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}

function BatchPlatformDialog({
  video,
  platforms,
  publishedIds,
  loading,
  onClose,
  onConfirm
}: {
  video: Video;
  platforms: Platform[];
  publishedIds: Set<number>;
  loading: boolean;
  onClose: () => void;
  onConfirm: (platformIds: number[]) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const selectablePlatforms = platforms.filter((item) => !publishedIds.has(item.id));

  function toggle(id: number) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="modal-backdrop">
      <div className="modal batch-platform-modal">
        <div className="modal-title">
          <div>
            <h2>批量添加平台</h2>
            <p className="modal-subtitle">{video.file_name}</p>
          </div>
          <button type="button" onClick={onClose} className="plain-button">
            <X size={18} />
          </button>
        </div>
        <div className="checkbox-list">
          {selectablePlatforms.map((item) => (
            <label className="checkbox-row" key={item.id}>
              <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggle(item.id)} />
              <span>{item.name}</span>
            </label>
          ))}
          {!selectablePlatforms.length && <div className="empty-inline">该视频已添加所有启用平台</div>}
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={loading || !selectedIds.size}
            onClick={() => onConfirm([...selectedIds])}
          >
            确认添加
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewDialog({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal preview-modal">
        <div className="modal-title">
          <div>
            <h2>{target.title}</h2>
            <p className="modal-subtitle">{target.subtitle}</p>
          </div>
          <button type="button" onClick={onClose} className="plain-button">
            <X size={18} />
          </button>
        </div>
        <video className="video-preview" controls preload="metadata" src={target.src} />
      </div>
    </div>
  );
}

function parseTimeInput(value: string) {
  const text = value.trim();
  if (!text) return 0;
  if (!text.includes(":")) return Number(text);
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function formatPreciseTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const millis = Math.floor((seconds - Math.floor(seconds)) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

type SubtitleArea = [number, number, number, number];
type SubtitleAreaEditMode = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

function TaskConfigDialog({
  video,
  onClose,
  onCreated
}: {
  video: Video;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [cuts, setCuts] = useState<Array<{ start: string; end: string }>>([]);
  const [clipMode, setClipMode] = useState<"accurate" | "lossless">("accurate");
  const [subtitleEnabled, setSubtitleEnabled] = useState(false);
  const [subtitleMode, setSubtitleMode] = useState<"sttn-auto" | "sttn-det" | "lama" | "propainter" | "opencv">("sttn-auto");
  const [areas, setAreas] = useState<SubtitleArea[]>([]);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [areaEdit, setAreaEdit] = useState<{
    index: number;
    mode: SubtitleAreaEditMode;
    startPoint: { x: number; y: number };
    startArea: SubtitleArea;
  } | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(video.duration_seconds || 0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const parsedCuts = cuts
    .map((cut) => ({ start: parseTimeInput(cut.start), end: parseTimeInput(cut.end) }))
    .filter((cut) => Number.isFinite(cut.start) && Number.isFinite(cut.end) && cut.end > cut.start);

  function updateCut(index: number, key: "start" | "end", value: string) {
    setCuts((current) => current.map((cut, itemIndex) => (itemIndex === index ? { ...cut, [key]: value } : cut)));
  }

  function getVideoBox() {
    const videoElement = videoRef.current;
    const shell = shellRef.current;
    if (!videoElement || !shell || !videoElement.videoWidth || !videoElement.videoHeight) return null;
    const rect = shell.getBoundingClientRect();
    const videoRatio = videoElement.videoWidth / videoElement.videoHeight;
    const shellRatio = rect.width / rect.height;
    let width = rect.width;
    let height = rect.height;
    let left = 0;
    let top = 0;
    if (shellRatio > videoRatio) {
      width = rect.height * videoRatio;
      left = (rect.width - width) / 2;
    } else {
      height = rect.width / videoRatio;
      top = (rect.height - height) / 2;
    }
    return { left, top, width, height, videoWidth: videoElement.videoWidth, videoHeight: videoElement.videoHeight };
  }

  function pointerToVideoPoint(event: PointerEvent<HTMLElement>) {
    const box = getVideoBox();
    const shell = shellRef.current;
    if (!box || !shell) return null;
    const rect = shell.getBoundingClientRect();
    const x = Math.max(0, Math.min(box.width, event.clientX - rect.left - box.left));
    const y = Math.max(0, Math.min(box.height, event.clientY - rect.top - box.top));
    return { x, y, box };
  }

  function pointerToSourcePoint(event: PointerEvent<HTMLElement>) {
    const point = pointerToVideoPoint(event);
    if (!point) return null;
    return {
      x: Math.round((point.x / point.box.width) * point.box.videoWidth),
      y: Math.round((point.y / point.box.height) * point.box.videoHeight),
      box: point.box
    };
  }

  function clampArea(area: SubtitleArea, videoWidth: number, videoHeight: number): SubtitleArea {
    const minSize = 4;
    let [ymin, ymax, xmin, xmax] = area.map(Math.round) as SubtitleArea;
    xmin = Math.max(0, Math.min(videoWidth - minSize, xmin));
    xmax = Math.max(xmin + minSize, Math.min(videoWidth, xmax));
    ymin = Math.max(0, Math.min(videoHeight - minSize, ymin));
    ymax = Math.max(ymin + minSize, Math.min(videoHeight, ymax));
    return [ymin, ymax, xmin, xmax];
  }

  function areaFromEdit(mode: SubtitleAreaEditMode, startArea: SubtitleArea, dx: number, dy: number, videoWidth: number, videoHeight: number): SubtitleArea {
    const [startYmin, startYmax, startXmin, startXmax] = startArea;
    const width = startXmax - startXmin;
    const height = startYmax - startYmin;
    let ymin = startYmin;
    let ymax = startYmax;
    let xmin = startXmin;
    let xmax = startXmax;

    if (mode === "move") {
      xmin = Math.max(0, Math.min(videoWidth - width, startXmin + dx));
      xmax = xmin + width;
      ymin = Math.max(0, Math.min(videoHeight - height, startYmin + dy));
      ymax = ymin + height;
      return clampArea([ymin, ymax, xmin, xmax], videoWidth, videoHeight);
    }

    if (mode.includes("w")) xmin = startXmin + dx;
    if (mode.includes("e")) xmax = startXmax + dx;
    if (mode.includes("n")) ymin = startYmin + dy;
    if (mode.includes("s")) ymax = startYmax + dy;
    return clampArea([ymin, ymax, xmin, xmax], videoWidth, videoHeight);
  }

  function startAreaEdit(index: number, mode: SubtitleAreaEditMode, event: PointerEvent<HTMLElement>) {
    if (!subtitleEnabled) return;
    const point = pointerToSourcePoint(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setAreaEdit({ index, mode, startPoint: { x: point.x, y: point.y }, startArea: areas[index] });
  }

  function areaToScreen(area: SubtitleArea) {
    const box = getVideoBox();
    if (!box) return null;
    const [ymin, ymax, xmin, xmax] = area;
    return {
      left: box.left + (xmin / box.videoWidth) * box.width,
      top: box.top + (ymin / box.videoHeight) * box.height,
      width: ((xmax - xmin) / box.videoWidth) * box.width,
      height: ((ymax - ymin) / box.videoHeight) * box.height
    };
  }

  function seekTo(value: number) {
    const videoElement = videoRef.current;
    if (!videoElement || !Number.isFinite(value)) return;
    const next = Math.max(0, Math.min(duration || videoElement.duration || 0, value));
    videoElement.currentTime = next;
    setCurrentTime(next);
  }

  async function togglePlay() {
    const videoElement = videoRef.current;
    if (!videoElement) return;
    if (videoElement.paused) {
      await videoElement.play();
    } else {
      videoElement.pause();
    }
  }

  async function submit() {
    setError("");
    if (!parsedCuts.length && !subtitleEnabled) {
      setError("请至少配置剪辑片段或启用去字幕。");
      return;
    }
    setSaving(true);
    try {
      await requestJson(`/api/videos/${video.id}/processing-task`, {
        method: "POST",
        body: JSON.stringify({
          cuts: parsedCuts,
          clipMode,
          subtitle: {
            enabled: subtitleEnabled,
            mode: subtitleMode,
            areas
          }
        })
      });
      await onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建处理任务失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal task-modal">
        <div className="modal-title">
          <div>
            <h2>添加处理任务</h2>
            <p className="modal-subtitle">{video.file_name}</p>
          </div>
          <button type="button" onClick={onClose} className="plain-button">
            <X size={18} />
          </button>
        </div>

        <div className="task-config-grid">
          <aside className="task-settings">
            <section className="form-section">
              <div className="form-section-title">剪辑删除片段</div>
              <label>
                剪辑模式
                <select value={clipMode} onChange={(event) => setClipMode(event.target.value as typeof clipMode)}>
                  <option value="accurate">精确重编码</option>
                  <option value="lossless">快速无损剪头尾</option>
                </select>
              </label>
              <div className="cut-list">
                {cuts.map((cut, index) => (
                  <div className="cut-row" key={index}>
                    <input value={cut.start} onChange={(event) => updateCut(index, "start", event.target.value)} placeholder="开始 0 或 00:00:03" />
                    <input value={cut.end} onChange={(event) => updateCut(index, "end", event.target.value)} placeholder="结束 3.5" />
                    <button className="danger-button" onClick={() => setCuts((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
              <button className="secondary-button" onClick={() => setCuts((current) => [...current, { start: "", end: "" }])}>
                添加删除片段
              </button>
            </section>

            <section className="form-section">
              <label className="checkbox-row">
                <input type="checkbox" checked={subtitleEnabled} onChange={(event) => setSubtitleEnabled(event.target.checked)} />
                <span>启用 AI 去字幕</span>
              </label>
              <label>
                去字幕模式
                <select value={subtitleMode} onChange={(event) => setSubtitleMode(event.target.value as typeof subtitleMode)} disabled={!subtitleEnabled}>
                  <option value="sttn-auto">sttn-auto 智能擦除</option>
                  <option value="sttn-det">sttn-det 检测擦除</option>
                  <option value="lama">lama</option>
                  <option value="propainter">propainter</option>
                  <option value="opencv">opencv</option>
                </select>
              </label>
              <div className="modal-actions align-left">
                <button className="secondary-button" onClick={() => setAreas([])} disabled={!subtitleEnabled}>清空区域</button>
                <button
                  className="secondary-button"
                  disabled={!subtitleEnabled}
                  onClick={() => {
                    const videoElement = videoRef.current;
                    if (!videoElement?.videoWidth || !videoElement.videoHeight) return;
                    setAreas([[Math.round(videoElement.videoHeight * 0.8), videoElement.videoHeight, 0, videoElement.videoWidth]]);
                  }}
                >
                  底部 20%
                </button>
              </div>
              <div className="subtitle-area-list">
                {areas.map((area, index) => (
                  <div className="subtitle-area-row" key={index}>
                    <span>{index + 1}. {area.join(" ")}</span>
                    <button className="danger-button" onClick={() => setAreas((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                {!areas.length && <div className="empty-inline">未选择区域时，VSR 会尝试处理全屏文字。</div>}
              </div>
            </section>
          </aside>

          <section className="task-preview">
            <div className="subtitle-video-shell" ref={shellRef}>
              <video
                ref={videoRef}
                className="subtitle-video"
                preload="metadata"
                src={`/api/videos/${video.id}/stream`}
                onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || video.duration_seconds || 0)}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />
              <div
                className={subtitleEnabled ? "subtitle-overlay" : "subtitle-overlay disabled"}
                onPointerDown={(event) => {
                  if (!subtitleEnabled) return;
                  const point = pointerToVideoPoint(event);
                  if (!point) return;
                  setDragStart({ x: point.x, y: point.y });
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (subtitleEnabled && areaEdit) {
                    const point = pointerToSourcePoint(event);
                    if (!point) return;
                    const dx = point.x - areaEdit.startPoint.x;
                    const dy = point.y - areaEdit.startPoint.y;
                    const nextArea = areaFromEdit(areaEdit.mode, areaEdit.startArea, dx, dy, point.box.videoWidth, point.box.videoHeight);
                    setAreas((current) => current.map((area, index) => (index === areaEdit.index ? nextArea : area)));
                    return;
                  }
                  if (!subtitleEnabled || !dragStart) return;
                  const point = pointerToVideoPoint(event);
                  const box = getVideoBox();
                  if (!point || !box) return;
                  setDragRect({
                    left: box.left + Math.min(dragStart.x, point.x),
                    top: box.top + Math.min(dragStart.y, point.y),
                    width: Math.abs(point.x - dragStart.x),
                    height: Math.abs(point.y - dragStart.y)
                  });
                }}
                onPointerUp={(event) => {
                  if (areaEdit) {
                    setAreaEdit(null);
                    return;
                  }
                  if (!subtitleEnabled || !dragStart) return;
                  const point = pointerToVideoPoint(event);
                  if (point) {
                    const xmin = Math.round((Math.min(dragStart.x, point.x) / point.box.width) * point.box.videoWidth);
                    const xmax = Math.round((Math.max(dragStart.x, point.x) / point.box.width) * point.box.videoWidth);
                    const ymin = Math.round((Math.min(dragStart.y, point.y) / point.box.height) * point.box.videoHeight);
                    const ymax = Math.round((Math.max(dragStart.y, point.y) / point.box.height) * point.box.videoHeight);
                    if (xmax - xmin >= 4 && ymax - ymin >= 4) {
                      setAreas((current) => [...current, [ymin, ymax, xmin, xmax]]);
                    }
                  }
                  setDragStart(null);
                  setDragRect(null);
                }}
                onPointerCancel={() => {
                  setAreaEdit(null);
                  setDragStart(null);
                  setDragRect(null);
                }}
              >
                {areas.map((area, index) => {
                  const rect = areaToScreen(area);
                  if (!rect) return null;
                  return (
                    <span
                      className="subtitle-selection"
                      key={index}
                      style={rect}
                      onPointerDown={(event) => startAreaEdit(index, "move", event)}
                    >
                      {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((handle) => (
                        <span
                          className={`subtitle-handle ${handle}`}
                          key={handle}
                          onPointerDown={(event) => startAreaEdit(index, handle, event)}
                        />
                      ))}
                    </span>
                  );
                })}
                {dragRect && <span className="subtitle-drag-rect" style={dragRect} />}
              </div>
            </div>

            <div className="video-control-panel">
              <div className="video-buttons">
                <button className="secondary-button" onClick={() => seekTo(currentTime - 5)}>-5s</button>
                <button className="secondary-button" onClick={() => seekTo(currentTime - 1)}>-1s</button>
                <button className="primary-button" onClick={togglePlay}>{playing ? "暂停" : "播放"}</button>
                <button className="secondary-button" onClick={() => seekTo(currentTime + 1)}>+1s</button>
                <button className="secondary-button" onClick={() => seekTo(currentTime + 5)}>+5s</button>
                <span className="time-readout">{formatPreciseTime(currentTime)} / {formatPreciseTime(duration)}</span>
              </div>
              <input type="range" min={0} max={duration || 0} step={0.001} value={currentTime} onChange={(event) => seekTo(Number(event.target.value))} />
            </div>
          </section>
        </div>

        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" onClick={submit} disabled={saving}>
            {saving ? "添加中" : "添加到任务队列"}
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>
    </div>
  );
}

function ClipDialog({
  video,
  onClose,
  onCreated
}: {
  video: Video;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [cuts, setCuts] = useState<Array<{ start: string; end: string }>>([{ start: "0", end: "" }]);
  const [mode, setMode] = useState<"accurate" | "lossless">("accurate");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const parsedCuts = cuts
    .map((cut) => ({ start: parseTimeInput(cut.start), end: parseTimeInput(cut.end) }))
    .filter((cut) => Number.isFinite(cut.start) && Number.isFinite(cut.end) && cut.end > cut.start);

  function updateCut(index: number, key: "start" | "end", value: string) {
    setCuts((current) => current.map((cut, itemIndex) => (itemIndex === index ? { ...cut, [key]: value } : cut)));
  }

  async function submit() {
    setError("");
    if (!parsedCuts.length) {
      setError("请至少填写一个有效删除片段。");
      return;
    }
    setSaving(true);
    try {
      await requestJson(`/api/videos/${video.id}/clip`, {
        method: "POST",
        body: JSON.stringify({ cuts: parsedCuts, mode })
      });
      await onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建剪辑任务失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal clip-modal">
        <div className="modal-title">
          <div>
            <h2>剪辑处理</h2>
            <p className="modal-subtitle">{video.file_name}</p>
          </div>
          <button type="button" onClick={onClose} className="plain-button">
            <X size={18} />
          </button>
        </div>
        <video className="video-preview compact-preview" controls preload="metadata" src={`/api/videos/${video.id}/stream`} />
        <div className="timeline">
          {parsedCuts.map((cut, index) => {
            const left = video.duration_seconds ? Math.max(0, Math.min(100, (cut.start / video.duration_seconds) * 100)) : 0;
            const width = video.duration_seconds ? Math.max(1, Math.min(100 - left, ((cut.end - cut.start) / video.duration_seconds) * 100)) : 0;
            return <span key={index} style={{ left: `${left}%`, width: `${width}%` }} />;
          })}
        </div>
        <label>
          处理模式
          <select value={mode} onChange={(event) => setMode(event.target.value as "accurate" | "lossless")}>
            <option value="accurate">精确剪辑</option>
            <option value="lossless">快速无损剪头尾</option>
          </select>
        </label>
        <div className="cut-list">
          {cuts.map((cut, index) => (
            <div className="cut-row" key={index}>
              <input value={cut.start} onChange={(event) => updateCut(index, "start", event.target.value)} placeholder="开始，如 0 或 00:00:03" />
              <input value={cut.end} onChange={(event) => updateCut(index, "end", event.target.value)} placeholder="结束，如 3.5" />
              <button className="danger-button" onClick={() => setCuts((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
        <button className="secondary-button" onClick={() => setCuts((current) => [...current, { start: "", end: "" }])}>
          添加删除片段
        </button>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" onClick={submit} disabled={saving}>
            {saving ? "创建中" : "生成处理中视频"}
          </button>
        </div>
      </div>
    </div>
  );
}

function jobTypeLabel(type: ProcessingJob["type"]) {
  if (type === "video_process") return "综合处理";
  if (type === "subtitle_remove") return "去字幕";
  return "剪辑";
}

function parseJobLogs(job: ProcessingJob) {
  try {
    const parsed = JSON.parse(job.log_json || "[]");
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    return [];
  }
  return [];
}

function JobLogDialog({ job, onClose }: { job: ProcessingJob; onClose: () => void }) {
  const logs = parseJobLogs(job);
  return (
    <div className="modal-backdrop">
      <div className="modal log-modal">
        <div className="modal-title">
          <div>
            <h2>处理日志</h2>
            <p className="modal-subtitle">{job.source_file_name ?? `任务 ${job.id}`}</p>
          </div>
          <button type="button" onClick={onClose} className="plain-button">
            <X size={18} />
          </button>
        </div>
        <div className="log-summary">
          <span>{jobTypeLabel(job.type)}</span>
          <span>{job.status}</span>
          <span>{Math.round(job.progress)}%</span>
        </div>
        <pre className="log-box">{logs.length ? logs.join("\n") : job.message || job.error || "暂无日志"}</pre>
      </div>
    </div>
  );
}

function JobHistoryDialog({
  jobs,
  loading,
  onClose,
  onConfirm
}: {
  jobs: ProcessingJob[];
  loading: boolean;
  onClose: () => void;
  onConfirm: (job: ProcessingJob) => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal preview-modal">
        <div className="modal-title">
          <h2>处理历史</h2>
          <button type="button" onClick={onClose} className="plain-button">
            <X size={18} />
          </button>
        </div>
        <div className="job-list">
          {jobs.map((job) => (
            <div className="job-row" key={job.id}>
              <div>
                <strong>{jobTypeLabel(job.type)} · {job.source_file_name ?? `视频 ${job.source_video_id}`}</strong>
                <div className="file-path">{job.output_file_name ? `输出：${job.output_file_name}` : job.message || job.error}</div>
                {job.message && job.output_file_name && <div className="file-path">{job.message}</div>}
              </div>
              <div className="job-side">
                <div className={`job-status ${job.status}`}>
                  {job.status} {Math.round(job.progress)}%
                </div>
                {job.status === "completed" && (job.output_video_id || job.output_relative_path) && job.output_library !== "processed" && (
                  <button className="primary-button" disabled={loading} onClick={() => onConfirm(job)}>
                    确认入库
                  </button>
                )}
                {job.status === "confirming" && (
                  <button className="secondary-button" disabled>
                    确认中
                  </button>
                )}
              </div>
              <div className="progress-track">
                <span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
              </div>
            </div>
          ))}
          {!jobs.length && <div className="empty-inline">暂无处理历史</div>}
        </div>
      </div>
    </div>
  );
}

function AddVideoDialog({
  targetLibrary,
  platforms,
  onClose,
  onSaved
}: {
  targetLibrary: "unprocessed" | "processed";
  platforms: Platform[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [selectedPlatformIds, setSelectedPlatformIds] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function togglePlatform(id: number) {
    setSelectedPlatformIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!file) {
      setError("请选择要上传的视频文件");
      return;
    }

    setSaving(true);
    try {
      const formData = new FormData();
      formData.append("library", targetLibrary);
      formData.append("note", note);
      formData.append("lastModified", String(file.lastModified));
      if (targetLibrary === "processed") {
        for (const platformId of selectedPlatformIds) {
          formData.append("platformIds", String(platformId));
        }
      }
      formData.append("file", file);

      await requestJson("/api/videos/upload", {
        method: "POST",
        body: formData
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <div className="modal-title">
          <h2>{targetLibrary === "processed" ? "添加已处理视频" : "添加未处理视频"}</h2>
          <button type="button" onClick={onClose} className="plain-button">
            <X size={18} />
          </button>
        </div>
        {targetLibrary === "processed" && (
          <div className="form-section">
            <div className="form-section-title">已发布平台</div>
            <div className="checkbox-list compact">
              {platforms.map((item) => (
                <label className="checkbox-row" key={item.id}>
                  <input type="checkbox" checked={selectedPlatformIds.has(item.id)} onChange={() => togglePlatform(item.id)} />
                  <span>{item.name}</span>
                </label>
              ))}
              {!platforms.length && <div className="empty-inline">暂无启用平台</div>}
            </div>
          </div>
        )}
        {targetLibrary === "unprocessed" && <div className="empty-inline">上传后进入未处理列表，可继续配置处理任务。</div>}
        <label>
          视频文件
          <input
            type="file"
            accept=".mp4,.mov,.mkv,.webm,.avi,.m4v,video/*"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
          />
        </label>
        <label>
          备注
          <textarea value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? "上传中" : "上传"}
          </button>
        </div>
      </form>
    </div>
  );
}

function PlatformDialog({
  platforms,
  onClose,
  onSaved,
  onDeleted
}: {
  platforms: Platform[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted: (id: number) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function addPlatform(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await requestJson("/api/platforms", { method: "POST", body: JSON.stringify({ name }) });
      setName("");
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  async function toggle(item: Platform) {
    await requestJson(`/api/platforms/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !item.enabled })
    });
    await onSaved();
  }

  async function deletePlatform(item: Platform) {
    if (!window.confirm(`删除平台「${item.name}」？对应视频的发布标记也会被移除。`)) {
      return;
    }

    await requestJson(`/api/platforms/${item.id}`, { method: "DELETE" });
    onDeleted(item.id);
    await onSaved();
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-title">
          <h2>平台管理</h2>
          <button type="button" onClick={onClose} className="plain-button">
            <X size={18} />
          </button>
        </div>
        <form className="inline-form" onSubmit={addPlatform}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="新增平台名称" required />
          <button className="primary-button" type="submit">
            添加
          </button>
        </form>
        {error && <div className="form-error">{error}</div>}
        <div className="platform-list">
          {platforms.map((item) => (
            <div className="platform-row" key={item.id}>
              <span>{item.name}</span>
              <div className="row-actions">
                <button className={item.enabled ? "secondary-button" : "primary-button"} onClick={() => toggle(item)}>
                  {item.enabled ? "禁用" : "启用"}
                </button>
                <button className="danger-button" onClick={() => deletePlatform(item)} title="删除平台">
                  <Trash2 size={17} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
