# 视频管理工具

用于管理 NAS 上的视频文件、处理任务、已发布平台和处理结果确认。当前项目把 Web 和 API 打包在同一个 Docker 容器内运行，字幕擦除能力通过外部 VSR API 服务调用。

## 当前能力

- 扫描 NAS 目录并同步视频元数据。
- 支持未处理、处理中、归档、已处理四类状态。
- 未处理视频可以添加处理任务，支持剪辑、去字幕和综合处理。
- 处理任务支持队列、进度、详细日志、取消和结果确认。
- 处理完成后先生成待确认结果，确认后加入已处理库。
- 确认入库时，处理结果移动到已处理库，原视频从未处理库移动到归档库。
- 归档库视频支持手动移动回未处理库。
- 已处理视频支持标记发布平台，并按修改时间和平台重命名。
- 所有库的视频都支持预览、下载和删除。
- 页面删除视频会同步删除 NAS 上的实际文件。
- 反向同步：扫描时会根据 NAS 目录内容补充或清理数据库记录。

## 服务端口

Docker 部署时：

```text
Web: http://localhost:5333
API: 容器内 8333，由 Nginx 通过 /api 转发
VSR: http://host.docker.internal:8332
```

本地开发时：

```text
Web: http://localhost:5173
API: http://localhost:3001
```

## 目录约定

NAS 挂载目录默认是：

```text
/mnt/video-manager/
  unprocessed/  未处理原视频
  processing/   处理结果待确认
  archived/     已处理原视频归档
  processed/    已确认的成品视频
```

数据库只保存库类型和相对路径，实际文件以 NAS 目录为准。

## 依赖服务

字幕擦除服务使用另一个仓库 `video-subtitle-remover` 提供的 API。

默认地址：

```text
http://host.docker.internal:8332
```

如果不是 Docker 部署，默认可用：

```text
http://127.0.0.1:8332
```

## Docker 部署

先确保 NAS 已挂载到：

```text
/mnt/video-manager
```

然后启动：

```bash
docker compose up -d --build
```

访问：

```text
http://localhost:5333
```

查看状态：

```bash
docker compose ps
docker compose logs -f video-manager
```

停止：

```bash
docker compose down
```

## Docker 配置

`docker-compose.yml` 默认配置：

```yaml
ports:
  - "5333:5333"
environment:
  HOST: 127.0.0.1
  PORT: 8333
  WEB_ORIGIN: http://localhost:5333
  DATABASE_PATH: /data/video-manager.db
  VSR_API_URL: http://host.docker.internal:8332
  VIDEO_UNPROCESSED_DIR: /videos/unprocessed
  VIDEO_PROCESSING_DIR: /videos/processing
  VIDEO_ARCHIVED_DIR: /videos/archived
  VIDEO_PROCESSED_DIR: /videos/processed
volumes:
  - ./data:/data
  - /mnt/video-manager:/videos
```

## 本地开发

安装依赖：

```bash
npm install
```

复制配置：

```bash
cp .env.example .env
```

本地 `.env` 建议：

```env
HOST=0.0.0.0
PORT=3001
DATABASE_PATH=./data/video-manager.db
VIDEO_UNPROCESSED_DIR=/mnt/video-manager/unprocessed
VIDEO_PROCESSING_DIR=/mnt/video-manager/processing
VIDEO_ARCHIVED_DIR=/mnt/video-manager/archived
VIDEO_PROCESSED_DIR=/mnt/video-manager/processed
WEB_ORIGIN=http://localhost:5173
VSR_API_URL=http://127.0.0.1:8332
```

同时启动 API 和 Web：

```bash
npm run dev
```

也可以分别启动：

```bash
npm run dev:api
npm run dev:web
```

## 常用命令

类型检查和构建：

```bash
npm run typecheck
npm run build
```

健康检查：

```bash
curl http://localhost:3001/api/health
```

触发扫描：

```bash
curl -X POST http://localhost:3001/api/scans/run
```

上传视频：

```bash
curl -X POST http://localhost:3001/api/videos/upload \
  -F library=unprocessed \
  -F file=@/path/to/video.mp4
```

## NAS 挂载

NFS 挂载说明见：

```text
docs/nas-nfs-mount.md
```
