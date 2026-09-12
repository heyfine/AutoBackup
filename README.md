# AutoBackup

VPS 上的自动备份中心：**自动检测应用 → 一致性快照 → 合并打包加密 → 推送多 WebDAV 网盘 → 自定义保留 → 失败必告警 → 一键整体还原**。

一句话：让「备份真的发生、丢了真的能恢复」。

> 备份最大的敌人不是没写备份脚本，而是：脚本悄悄死了没人知道、直接复制的数据库文件是坏的、真出事那晚才发现恢复步骤没人写得全。AutoBackup 把这三个问题都变成流水线的一部分。

## 它能做什么

- **多类型合并备份（v2）**：一个备份档案可同时勾选多种内容——SQLite 数据库 / MariaDB / PostgreSQL / 数据目录 / 配置文件——合并为一个压缩包，还原时一次到位
- **类型自动识别**：打开编辑器即按容器镜像、挂载点、路径探测机器上可备份的项，并显示大小
- **一致性快照**：SQLite 走官方 backup API 在线热备并跑 integrity_check；MariaDB `--single-transaction`；PostgreSQL `pg_dump -Fc`；数据库凭据经 `--defaults-extra-file` 注入，不进命令行
- **加密**：敏感档案 age 加密，备份包落到第三方网盘也不可读；manifest 清单保持明文，供远端浏览与 sha256 校验
- **多 WebDAV 目标**：同时推多家网盘（Koofr、InfiniCloud 等 WebDAV 服务均可），每家独立保留份数与容量水位预警
- **失败必告警**：任何一次运行失败，Bark 推送直达手机，还可叠加邮箱（SMTP）第二通道双路齐发、互不阻塞——静默失败零容忍
- **一键整体还原**：按 manifest 路由恢复全部勾选项；数据库自动停容器 → 校验 → 替换 → 起容器；还原前自动兜底当前数据，还原本身可回退
- **临时产物自动清理**：预览解包 / 还原工作区 / 兜底备份 24h 自动删除
- **Web 控制台**：单管理员登录，档案、目标、运行记录、还原全部网页操作

## 工作原理

```
调度器（daily / interval）或手动触发
        │
        ▼
一致性快照（按类型：sqlite backup API / mariadb-dump / pg_dump / 目录归并）
        │
        ▼
tar.gz 打包 ──(敏感档案)──> age 加密          + manifest.json（明文清单）
        │
        ▼
推送全部启用的 WebDAV 目标 → sha256 校验 → 按保留策略裁剪旧包
        │
        ▼
成功：记录 runs 台账        失败：Bark 告警
```

## 快速开始（源码部署）

要求：Linux VPS（推荐）或任意能跑 Node.js ≥ 22 的机器，pnpm，Docker（仅当你要备份数据库容器）。

```bash
git clone https://github.com/heyfine/AutoBackup.git
cd AutoBackup
pnpm install
pnpm build
```

### 1. 配置 secrets

在运行目录创建 `secrets.env`（权限 0600）：

```bash
# WebDAV 目标（可配多个，编号递增）
WEBDAV_1_URL=https://app.koofr.net/dav/backup
WEBDAV_1_USER=you@example.com
WEBDAV_1_PASS=your-password
# WEBDAV_2_URL=...

# age 加密公钥（敏感档案必填；age-keygen 生成）
AGE_RECIPIENT=age1xxxxxxxxxxxxxxxxxxxx

# Bark 失败告警（不配则只写日志）
BARK_URL=https://api.day.app/yourkey

# 邮箱告警（可选第二通道；任何可开 SMTP 的邮箱，QQ/163 用「授权码」而非登录密码）
# SMTP_HOST=smtp.qq.com
# SMTP_PORT=465            # 465=SSL，587=STARTTLS
# SMTP_USER=you@qq.com     # 发件邮箱
# SMTP_PASS=your-authcode  # SMTP 授权码
# MAIL_TO=you@qq.com       # 收件邮箱（可与他人不同）
```

### 2. 创建管理员账号

启动服务后首次打开 Web 控制台，会直接看到**「创建管理员账号」**界面——自定义用户名 + 设置密码（≥8 位）即完成初始化，创建成功直接进入。**用户名之后可在「设置 → 管理员账号」随时修改**；密码创建后该入口永久关闭，找回需登录服务器重建。

> 老手也可预先在运行目录放置 `admin-password.txt`（`chmod 600`），此时直接进入登录，默认用户名为 `admin`。

### 3. 启动常驻服务

```bash
node dist/src/index.js serve
# 默认监听 127.0.0.1:8199（AUTOBACKUP_PORT 可改）
```

浏览器打开控制台（公网访问建议套一层 Nginx 反代），用上面设置的密码登录。

### 4. 生产环境用 systemd 托管（推荐）

仓库自带加固版 unit（`deploy/autobackup.service`）：CPU/内存限额、最小可写路径、PrivateTmp 等安全加固。按注释改好路径后：

```bash
cp deploy/autobackup.service /etc/systemd/system/autobackup.service
systemctl daemon-reload && systemctl enable --now autobackup
```

## 使用指南（Web 控制台）

1. **添加备份档案**：打开编辑器，AutoBackup 会自动探测本机可备份项（Docker 容器、数据库、数据目录）并列出大小——勾选你要的内容，一个档案可混合多种类型
2. **添加备份目标**：填入 WebDAV 地址与凭据，设置保留份数与容量预警水位，可添加多个并按需启用
3. **设置调度**：每日定时或固定间隔；不手动干预，备份就会自己发生
4. **看运行台账**：每次运行的开始时间、耗时、包大小、sha256、成败状态全部留档——备份不再是"薛定谔的"
5. **还原**：选一个历史备份包 → **预览**（解包查看内容清单）→ **整体还原**。数据库部分自动停容器→校验→替换→起容器；目录/配置直接覆盖；动手前当前数据会被自动兜底一份
6. **失败告警**：设置页提供 **Bark** 与 **邮箱（SMTP）** 两条通道，配齐即启用、双路同时推送互不阻塞，各带「发测试」按钮当场验证；连续 3 次失败自动升级（Bark 持续响铃 / 邮件 🚨 高优先级）。CLI 部署也可直接写 `BARK_URL` / `SMTP_*` 进 `secrets.env`

## CLI 命令

```bash
node dist/src/index.js run <profileId>   # 手动备份一个档案
node dist/src/index.js run --all         # 手动跑全部启用档案
node dist/src/index.js status            # 查看档案与最近运行状态
node dist/src/index.js serve             # 常驻模式（调度器 + Web API）
```

## 备份包长什么样

```
backup_2026-09-10_03-30-00.tar.gz.age    # 主包（敏感档案加密）
backup_2026-09-10_03-30-00.manifest.json # 明文清单：parts 路由 + sha256 + 大小
```

包内按 `parts/<序号>_<类型>_<标签>/` 组织，还原时按 manifest 逐项路由——这就是"整体还原"能一次到位的原因。

## 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `AUTOBACKUP_PORT` | Web API 端口 | `8199` |
| `AUTOBACKUP_HOME` | 运行目录（secrets/密码/数据库所在） | 进程工作目录 |

WebDAV / age / Bark 凭据统一放 `secrets.env` 文件（0600），见上文快速开始。

## 安全模型

- 管理端单管理员；用户名+密码首启在网页自建（一次性创建窗口，建成即关），密码存 `admin-password.txt`（0600，不入库、永不回显），用户名存 `admin-username.txt`（未自定义时默认 `admin`）
- WebDAV / Bark / age 密钥集中 `secrets.env`（0600，原子写），不进 git、不走命令行
- 数据库凭据经 `--defaults-extra-file` 注入，不出现在进程列表
- 敏感备份包 age 加密后落网盘，manifest 明文仅供校验
- systemd unit 自带硬化配置（ProtectSystem / PrivateTmp / 资源限额）

## 常见问题

**Q：必须用 Docker 吗？**
工具本身不需要 Docker，但如果你想备份容器里的数据库（SQLite/MariaDB/Postgres），需要 Docker 来做停起容器和自动探测。

**Q：我的网盘不在支持列表里？**
任何标准 WebDAV 服务都可以——填 URL / 用户名 / 密码即可，没有服务商绑定。

**Q：备份包在网盘上是明文吗？**
不配置 `AGE_RECIPIENT` 时为明文 tar.gz（方便直接浏览）；敏感档案建议启用 age 加密，落网盘即密文。

**Q：还原会把我现在的数据弄丢吗？**
整体还原在动手前会把当前数据自动兜底一份（24h 后自动清理），还原动作本身是可回退的。

**Q：怎么验证备份是好的？**
每个包都有 sha256 校验；控制台里可以随时对历史备份做"预览"解包查看内容——定期演练一次还原是最稳妥的。

## 目录结构

```
src/
  index.ts            CLI 入口（run/status/serve）
  server.ts           Fastify Web API（单管理员会话 + 档案/目标/还原）
  core/
    executor.ts       一致性执行器（sqlite/mariadb/postgres/directory）
    packer.ts         tar.gz 打包 + age 加密 + manifest
    pipeline.ts       备份流水线（快照→打包→加密→推送→校验→裁剪→通知）
    restore.ts        还原（预览解包 / 整体还原）
    inspector.ts      类型自动识别（容器指纹/挂载点/路径 + 大小估算）
    scheduler.ts      调度器（daily / interval）
    webdav.ts         WebDAV 客户端
    secrets.ts        secrets.env 读写（0600，原子写）
    temp-cleanup.ts   临时目录 24h 自动清理
    notifier.ts       Bark 失败告警
  store/db.ts         SQLite 三表（apps/targets/runs）
web/                  Preact Web UI（Vite 构建）
deploy/               systemd unit（硬化配置）
scripts/              部署辅助脚本
```

## 更新规则

- 功能 / 命令 / 环境变量 / 部署方式变化 → 同步更新本文件
