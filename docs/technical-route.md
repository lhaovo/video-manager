# 视频管理工具技术路线

## 总体方案

项目采用 Web 应用架构：

```text
浏览器
  -> Web 前端
  -> HTTP API
  -> 后端服务
  -> SQLite 数据库
  -> NAS 挂载目录
```

视频文件保存在 NAS 上，后端服务通过 Linux 文件系统访问 NAS 挂载目录。

第一版不做纯前端应用，因为浏览器无法稳定完成以下能力：

- 扫描 NAS 目录。
- 调用 ffprobe 读取视频时长。
- 长期运行后台扫描任务。
- 直接管理服务端文件系统路径。
- 稳定保存本地 SQLite 数据库。

## 技术栈

第一版推荐：

- 前端：React + TypeScript + Vite
- 后端：Node.js + TypeScript + Fastify
- 数据库：SQLite
- ORM / 查询层：待定，优先选择轻量方案
- 视频信息读取：ffprobe
- NAS 连接：Linux 下优先 NFS 挂载
- 部署：Docker Compose

## NAS 挂载策略

开发和部署都按 Linux 环境设计。

推荐 NAS 访问方式：

- 后端部署在 NAS 自身：优先直接挂载 NAS 本地目录。
- 后端部署在 Linux 主机：优先 NFS。
- 外网访问：不要直接暴露 NFS / SMB / FTP，优先 VPN、Tailscale、ZeroTier、Cloudflare Tunnel 或 HTTPS 反向代理。

Linux + Docker 场景优先 NFS 的原因：

- NFS 更贴近 Linux 文件系统语义。
- 目录扫描和元数据读取通常更适合服务端长期任务。
- UID / GID 权限模型更适合 Linux 和容器。
- 宿主机挂载 NFS 后，容器只需要挂载本地目录。

示例：

```text
NAS NFS 导出目录：
/volume1/video-manager

Linux 宿主机挂载目录：
/mnt/video-manager

容器内目录：
/data/videos
```

Docker Compose 中只暴露容器内部统一路径：

```yaml
volumes:
  - /mnt/video-manager:/data/videos
```

## 目录设计

NAS 视频目录建议：

```text
/data/videos/
  unprocessed/
  processed/
```

应用配置：

```text
VIDEO_UNPROCESSED_DIR=/data/videos/unprocessed
VIDEO_PROCESSED_DIR=/data/videos/processed
```

数据库中不保存宿主机绝对路径，优先保存：

- 所属库：`unprocessed` / `processed`
- 相对路径：例如 `2026/04/example.mp4`

运行时根据所属库和配置目录拼出真实文件路径。

这样以后即使 NAS 挂载点变化，数据库也不需要整体迁移。

## 数据库设计

第一版使用 SQLite。

### videos

```text
id
library
relative_path
file_name
file_size
duration_seconds
status
note
created_at
updated_at
```

字段说明：

- `library`：`unprocessed` 或 `processed`
- `relative_path`：相对所属库根目录的路径
- `status`：`unprocessed` 或 `processed`
- `duration_seconds`：视频时长，单位为秒

建议唯一约束：

```text
unique(library, relative_path)
```

### platforms

```text
id
name
enabled
sort_order
created_at
updated_at
```

建议唯一约束：

```text
unique(name)
```

### video_publications

```text
id
video_id
platform_id
published_at
note
created_at
updated_at
```

建议唯一约束：

```text
unique(video_id, platform_id)
```

## 后端能力

后端负责：

- 读取和写入 SQLite。
- 扫描未处理目录和已处理目录。
- 调用 ffprobe 获取视频时长。
- 提供视频列表 API。
- 提供平台管理 API。
- 提供发布记录 API。
- 提供筛选、搜索、分页能力。

第一版 API 可按资源拆分：

```text
GET    /api/videos
POST   /api/videos
PATCH  /api/videos/:id
DELETE /api/videos/:id

POST   /api/scans/run

GET    /api/platforms
POST   /api/platforms
PATCH  /api/platforms/:id

POST   /api/videos/:id/publications
DELETE /api/videos/:id/publications/:platformId
```

## 前端能力

前端负责：

- 视频库列表。
- 状态筛选。
- 时长筛选。
- 发布平台筛选。
- 文件名搜索。
- 添加视频。
- 扫描触发。
- 平台管理。
- 视频发布平台标记和取消。

第一版页面：

- 视频库
- 添加视频
- 平台管理
- 扫描设置或扫描入口

## 部署方案

第一版使用 Docker Compose。

建议服务：

```text
api
web
```

SQLite 数据库使用 Docker volume 或宿主机目录持久化。

示例持久化路径：

```text
/opt/video-manager/data/video-manager.db
```

视频目录通过宿主机挂载进入容器：

```text
/mnt/video-manager:/data/videos
```

## 外网访问

第一版优先局域网访问。

需要外网访问时，推荐顺序：

1. Tailscale / ZeroTier VPN。
2. Cloudflare Tunnel。
3. HTTPS 反向代理 + 登录认证。

不建议：

- 直接暴露 NAS 的 NFS。
- 直接暴露 NAS 的 SMB。
- 直接暴露 FTP。

## 实现顺序

建议按以下顺序实现：

1. 初始化前后端项目和 Docker Compose。
2. 建立 SQLite 表结构和迁移机制。
3. 实现平台管理。
4. 实现目录扫描和 ffprobe 时长读取。
5. 实现视频列表 API。
6. 实现视频库页面和筛选。
7. 实现视频状态切换。
8. 实现发布平台标记。
9. 补充基础错误处理和日志。
