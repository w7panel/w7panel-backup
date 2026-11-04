# Velero 备份排障记录

## 统一发布命令

在项目根目录设置 `ZPK_IDC_PASSWORD` 后执行 `make full VERSION=x.y.z`，依次构建 UI、打包 Helm、推送 ZPK。本项目没有自有镜像，`build-image` 会跳过。单独执行阶段可用 `make build-ui`、`make build-helm VERSION=x.y.z`、`make push-zpk VERSION=x.y.z`；原有 `make all` 和 `CNB_BRANCH` 用法保留。

在 W7Panel 集群备份页面排障时，先查看 `Backup.status.validationErrors` 和 `BackupStorageLocation.status.message`；页面上的 `FailedValidation`、`Unavailable` 只是状态，不是具体原因。`FailedValidation` 的备份不会自动重试，修好存储位置后需用新名称创建备份。

- **本地 S3 无法解析**：确认 `local` 存储位置的 `spec.config.s3Url` 指向当前 Helm release 对应的 S3 Service。升级自内置 MinIO 时，设置 `legacyMinio.enabled=true` 以保留旧 Service、PVC 和只读 `default` 位置。存储位置变为 `Available` 后再创建备份。
- **浏览器下载**：内网本地 S3 或旧 MinIO 地址只能供集群内使用。下载需要浏览器和 Velero Pod 均可访问的公网 HTTPS S3 API 地址；Ingress 的 HTTPS 入口转发到 MinIO Service 的 `9000` 端口，`9001` 是控制台。外网开放前更换 Chart 的默认 MinIO 密码。
- **COS 返回 `PathStyleDomainForbidden`**：COS 存储位置关闭 `s3ForcePathStyle`。Bucket 单独填写完整名称，上海地域的 S3 Endpoint 填 `https://cos.ap-shanghai.myqcloud.com`；不要把 Bucket 名写进 Endpoint，否则 SDK 再加一次 Bucket，会产生重复域名和 TLS 证书错误。
- **COS 提示 invalid top-level directories**：目标 Bucket 顶层有非 Velero 目录。使用专用空 Bucket，或在 `spec.objectStorage.prefix` 设置独立目录；页面新建的位置可填写 Prefix；Helm 管理的位置需在部署配置中维护 Prefix。
- **COS `ListObjectsV2` 返回 `403 AccessDenied`**：请求已到达 COS，应核对密钥所属账号、Bucket 名以及该 Bucket 的列表权限（`cos:GetBucket`）；备份还需要对象读写权限。不要通过输出 Secret 的 `.data` 字段排障，即使内容是 base64 编码也属于敏感凭据。
- **下载归档出现重复目录**：Velero 会为同一个 Kubernetes 对象同时保存普通资源路径和 `v1-preferredversion` 路径；这属于备份归档格式，不表示集群里有两份对象。218 集群的 `full-20261013-18-06` 归档中有 7,994 对这类文件，逐对校验内容完全一致。不要手工删除归档内的任一路径，以免影响恢复。
