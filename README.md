# AutoBackup（自动备份）

VPS 上的常备份中心：自动检测应用 → 一致性快照 → 加密 → 推送多 WebDAV → 自定义保留 → 失败必吼 → 可验证还原。

一句话：让「备份真的发生、丢了真的能恢复」。

## 常用命令

```bash
pnpm install          # 安装依赖
pnpm dev              # 本地开发（直接跑 CLI 模式）
pnpm build            # 生产构建
pnpm typecheck        # 类型检查
pnpm lint             # lint 检查
pnpm test             # 运行测试
pnpm run format       # 格式化代码
```

## 目录结构

```
src/
  index.ts            CLI 入口（run/status/restore/serve）
  server.ts           Fastify + SSE 服务（Web UI 后端）
  core/
    config.ts         配置加载（profiles + secrets 引用）
    executor.ts       4 执行器：sqlite/mariadb/postgres/directory
    packer.ts         tar.zst 打包 + age 加密 + manifest
    webdav.ts         WebDAV 客户端（PUT/PROPFIND/MKCOL/DELETE）
    pipeline.ts       备份流水线（快照→打包→加密→推送→校验→裁剪→通知）
    retention.ts      保留策略（份数 + 容量水位，删最早）
    notifier.ts       Bark 失败告警 + 升级
    detector.ts       docker.sock 容器检测（出草稿档案）
  store/
    db.ts             SQLite 3 表（apps/targets/runs）
  web/                Preact Web UI（Vite 构建）
deploy/
  autobackup.service  systemd unit（硬化配置）
  autobackup.timer    systemd timer
docs/                 项目文档
```

## 环境变量 / Secrets

secrets 文件：`/opt/auto-backup/secrets.env`（0600 root，M1 开发期用本地 `./secrets.env`）。

| 变量 | 用途 | 必填 |
| --- | --- | --- |
| `BARK_URL` | Bark 推送 key | 否（未配置则只写日志） |
| `AGE_RECIPIENT` | age 加密公钥 | 敏感档案必填 |
| `WEBDAV_{N}_URL/USER/PASS` | WebDAV 目标凭据 | 是 |

详细设计见 [docs/落地方案-终版.md](docs/落地方案-终版.md)。

## AI 接手指南

1. 先读 [AGENTS.md](AGENTS.md)（行为约定）→ [docs/WIP.md](docs/WIP.md)（当前进度）→ [docs/PROJECT_MEMORY.md](docs/PROJECT_MEMORY.md)（环境/架构/踩坑）
2. 落地方案与评审记录：[docs/落地方案-终版.md](docs/落地方案-终版.md)

## 更新规则

- 项目名 / 简介 / 常用命令 / 目录结构 / 环境变量 / 部署地址发生变化时 → 同步更新本文件
