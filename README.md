# AutoBackup（自动备份）

VPS 上的备份中心：自动检测应用 → 多类型勾选 → 一致性快照 → 合并打包加密 → 推送多 WebDAV → 自定义保留 → 失败必吼 → 一键整体还原。

一句话：让「备份真的发生、丢了真的能恢复」。

## 核心特性

- **多类型合并备份（v2）**：一个档案可勾选多种内容（SQLite 数据库 / MariaDB / PostgreSQL / 数据目录 / 配置文件），自动识别可备份类型并显示大小，合并为一个压缩包
- **一致性快照**：SQLite 在线热备（backup API + integrity_check）；MariaDB `--single-transaction` dump；PG `pg_dump -Fc`；凭据走 `--defaults-extra-file` 不进命令行
- **整体还原**：一次操作恢复全部勾选项——数据库自动停容器→校验→替换→起容器；文件直接覆盖（还原前自动兜底当前数据）
- **类型自动识别**：按容器镜像/挂载点/路径探测可备份项 + 大小统计（打开编辑器即识别）
- **加密**：敏感档案 age 加密（备份包落网盘也不可读）；manifest 清单明文（供远端浏览与 sha256 校验）
- **临时产物自动清理**：预览解包/还原工作区/兜底备份 24h 自动删除
- **失败必告警**：Bark 推送，静默失败为零容忍

## 常用命令

```bash
pnpm install          # 安装依赖
pnpm dev              # 本地开发
pnpm build            # 生产构建（tsc）
pnpm typecheck        # 类型检查
pnpm lint             # lint 检查
pnpm test             # 运行测试
pnpm run format       # 格式化代码
```

## 目录结构

```
src/
  index.ts            CLI 入口（run/status/serve）+ serve 启动编排
  server.ts           Fastify Web API（单管理员 session + 档案/目标 CRUD + 还原）
  core/
    executor.ts       一致性执行器：sqlite/mariadb/postgres/directory（含多 part 调度）
    packer.ts         tar.gz 打包 + age 加密 + manifest（多 part 路由信息）
    pipeline.ts       备份流水线（快照→打包→加密→推送→校验→裁剪→通知）
    restore.ts        还原：预览解包 / 整体还原（按 manifest.parts 路由）
    inspector.ts      类型自动识别（容器指纹/挂载点/路径 + 大小估算）
    scheduler.ts      调度器（daily / interval）
    webdav.ts         WebDAV 客户端（PUT/PROPFIND/MKCOL/DELETE）
    secrets.ts        secrets.env 读写（0600，原子写）
    temp-cleanup.ts   临时目录 24h 自动清理
    notifier.ts       Bark 失败告警
    detector.ts       docker 容器检测（出草稿档案）
  store/
    db.ts             SQLite 3 表（apps/targets/runs）
web/                  Preact Web UI（Vite 构建）
deploy/
  autobackup.service  systemd unit（硬化配置）
scripts/              部署辅助脚本（VPS 档案注入/合并迁移）
```

## 环境变量 / Secrets

secrets 文件：`/opt/auto-backup/secrets.env`（0600 root，本地开发用 `./secrets.env`）。

| 变量 | 用途 | 必填 |
| --- | --- | --- |
| `BARK_URL` | Bark 推送 key | 否（未配置则只写日志） |
| `AGE_RECIPIENT` | age 加密公钥 | 敏感档案必填 |
| `WEBDAV_{N}_URL/USER/PASS` | WebDAV 目标凭据 | 是 |

## AI 接手指南

1. 先读 `AGENTS.md`（行为约定与文档地图）
2. 内部文档（docs/：WIP / PROJECT_MEMORY / 落地方案等）**不入 git**，在部署机或项目工作区查看

## 更新规则

- 项目名 / 简介 / 常用命令 / 目录结构 / 环境变量 / 部署地址发生变化时 → 同步更新本文件
