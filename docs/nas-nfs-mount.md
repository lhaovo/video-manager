# NAS NFS 挂载说明

本文记录当前机器挂载 NAS 视频目录的最终方案，方便后续部署、排错和迁移。

## 当前结果

当前项目使用 NFS 挂载 NAS 目录。

NAS 地址：

```text
192.168.0.109
```

NAS NFS 导出目录：

```text
/fs/1002/nfs
```

本机 NFS 根挂载点：

```text
/mnt/video-manager-nfs
```

项目实际使用目录：

```text
/mnt/video-manager
```

项目目录实际对应 NAS 内部路径：

```text
/fs/1002/nfs/fn_shared/video_manager
```

第一版应用配置建议：

```env
VIDEO_UNPROCESSED_DIR=/mnt/video-manager/unprocessed
VIDEO_PROCESSING_DIR=./data/processing
VIDEO_ARCHIVED_DIR=/mnt/video-manager/archived
VIDEO_PROCESSED_DIR=/mnt/video-manager/processed
```

注意：`processing` 处理中/待确认结果目录不建议放在 NAS 上，避免转码过程中的临时文件和半成品视频持续触发 NAS 同步。

## 为什么不是直接挂载 video_manager

NAS 当前 NFS 实际导出的是上层目录：

```text
/fs/1002/nfs
```

而不是直接导出：

```text
/fs/1002/nfs/fn_shared/video_manager
```

所以本机采用两步挂载：

1. 先把 NFS 导出根目录挂到 `/mnt/video-manager-nfs`。
2. 再把其中的 `fn_shared/video_manager` bind 到 `/mnt/video-manager`。

这样应用只需要关心稳定路径：

```text
/mnt/video-manager
```

## 安装依赖

Ubuntu / Debian 上需要安装 NFS 客户端工具：

```bash
sudo apt update
sudo apt install -y nfs-common
```

## 查看 NAS NFS 导出

```bash
showmount -e 192.168.0.109
```

当前正确结果应包含：

```text
Export list for 192.168.0.109:
/fs/1002/nfs *
```

如果这里没有导出项，或挂载时报 `access denied by server`，需要到 NAS 管理界面检查 NFS 权限。

## 手动挂载

创建挂载点：

```bash
sudo mkdir -p /mnt/video-manager-nfs
sudo mkdir -p /mnt/video-manager
```

挂载 NAS NFS 根目录：

```bash
sudo mount -t nfs -o vers=4.1 192.168.0.109:/fs/1002/nfs /mnt/video-manager-nfs
```

创建项目目录：

```bash
mkdir -p /mnt/video-manager-nfs/fn_shared/video_manager/unprocessed
mkdir -p /mnt/video-manager-nfs/fn_shared/video_manager/archived
mkdir -p /mnt/video-manager-nfs/fn_shared/video_manager/processed
```

bind 到项目使用路径：

```bash
sudo mount --bind /mnt/video-manager-nfs/fn_shared/video_manager /mnt/video-manager
```

验证：

```bash
findmnt /mnt/video-manager-nfs
findmnt /mnt/video-manager
ls -la /mnt/video-manager
ls -la /mnt/video-manager/unprocessed /mnt/video-manager/archived /mnt/video-manager/processed
```

## 开机自动挂载

编辑 `/etc/fstab`：

```bash
sudo nano /etc/fstab
```

追加：

```fstab
192.168.0.109:/fs/1002/nfs /mnt/video-manager-nfs nfs defaults,nofail,x-systemd.automount,_netdev,vers=4.1 0 0
/mnt/video-manager-nfs/fn_shared/video_manager /mnt/video-manager none bind,nofail,x-systemd.requires-mounts-for=/mnt/video-manager-nfs 0 0
```

测试配置：

```bash
sudo mount -a
findmnt /mnt/video-manager-nfs
findmnt /mnt/video-manager
```

## 取消挂载

先取消 bind 挂载，再取消 NFS 根挂载：

```bash
sudo umount /mnt/video-manager
sudo umount /mnt/video-manager-nfs
```

## NAS 端权限要求

NFS 通常不使用账号密码，而是依赖 NAS 端的客户端授权。

本机当前局域网 IP：

```text
192.168.0.103
```

NAS 端建议允许：

```text
192.168.0.103
```

或者允许整个局域网网段：

```text
192.168.0.0/24
```

权限建议：

```text
读写
```

如果 NAS 有 Squash / 用户映射选项，先使用能保证当前 Linux 用户可读写的设置。当前挂载后目录权限显示为 NAS 侧 UID/GID：

```text
1002:1001
```

项目目录当前为可读写权限：

```text
drwxrwxrwx
```

## 常见问题

### `access denied by server`

示例：

```text
mount.nfs: access denied by server while mounting 192.168.0.109:/fs/1002/nfs
```

含义：

```text
本机能连接到 NAS 的 NFS 服务，但 NAS 没有授权当前客户端 IP 挂载该导出目录。
```

处理：

1. 在 NAS 管理界面启用 NFS。
2. 确认导出目录是 `/fs/1002/nfs`。
3. 授权客户端 `192.168.0.103` 或 `192.168.0.0/24`。
4. 权限设为读写。
5. 再运行 `showmount -e 192.168.0.109` 和挂载命令测试。

### `\\192.168.0.109\fs\1002\nfs...` 不是 Linux NFS 挂载格式

这个写法看起来像 Windows / SMB 路径：

```text
\\192.168.0.109\fs\1002\nfs\fn_shared\video_manager
```

Linux NFS 挂载命令需要使用：

```text
服务器IP:/导出路径
```

例如：

```text
192.168.0.109:/fs/1002/nfs
```

本项目最终没有使用 SMB/CIFS 挂载。

## 当前 fstab 备份

本次配置前曾备份过 fstab：

```text
/etc/fstab.video-manager.bak
/etc/fstab.video-manager-nfs.bak
```
