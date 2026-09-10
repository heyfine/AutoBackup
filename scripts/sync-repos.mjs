// 同步脚本：把当前分支同时推送到公开仓库（origin）和私有全量仓库（private）。
//
// 公开仓库不含内部文档；私有仓库基于公开 main 补回内部文档后强制推送（备份镜像语义）。
// 内部文档清单以 .gitignore 中「内部开发文档」区块为准，避免多处维护。
//
// 用法：先在本地正常提交，然后 `pnpm run sync`。
// 要求：remote `origin`（公开）与 `private`（私有）已配置。
//
// 实现要点：快照 commit 通过底层命令在临时索引中构建（GIT_INDEX_FILE +
// read-tree/update-index/commit-tree），不切换分支、不改工作区 —— 避免分支
// 切换把「仅在快照分支中被跟踪」的内部文档从工作区删掉的事故。

import { readFileSync, rmSync, statSync, globSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const PRIVATE_REMOTE = 'private';
const INTERNAL_SECTION = '# 内部开发文档';
const TMP_INDEX = '.git/sync-repos-index.tmp';

function git(args, env) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env }).trim();
}

function readInternalDocs() {
  const lines = readFileSync('.gitignore', 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(INTERNAL_SECTION));
  if (start === -1) {
    throw new Error(`.gitignore 中找不到「${INTERNAL_SECTION}」区块，无法确定内部文档清单`);
  }
  const docs = lines
    .slice(start + 1)
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  const missing = docs.filter((doc) => !pathExists(doc) && globSync(doc, { exclude: () => false }).length === 0);
  if (missing.length > 0) {
    throw new Error(`内部文档缺失（.gitignore 有清单但工作区没有）：${missing.join(', ')}`);
  }
  return docs;
}

/** 存在性检查：文件或目录均算存在。 */
function pathExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') {
    throw new Error('当前处于 detached HEAD，请在正常分支上执行');
  }

  if (git(['status', '--porcelain']) !== '') {
    throw new Error('工作区有未提交的改动，请先 commit 再同步');
  }

  const docs = readInternalDocs();

  console.log(`[1/3] 推送 ${branch} → origin（公开仓库）`);
  git(['push', 'origin', branch]);

  console.log('[2/3] 在临时索引中构建全量快照 commit');
  const env = { ...process.env, GIT_INDEX_FILE: TMP_INDEX };
  try {
    git(['read-tree', 'HEAD'], env);
    git(['update-index', '--add', '--remove', ...docs], env);
    const tree = git(['write-tree'], env);
    // 私有快照以私有仓库 main 为父提交（快照历史线性累积）；私有仓库为空时无父提交
    let privateMain = null;
    try {
      privateMain = git(['rev-parse', '--verify', '--quiet', `${PRIVATE_REMOTE}/main`]);
    } catch {
      // 私有仓库还没有 main（首次同步），快照将是根提交
    }
    const parents = privateMain ? ['-p', privateMain] : [];
    const message = `全量快照 ${new Date().toISOString().slice(0, 10)}（基于 ${git(['rev-parse', '--short', 'HEAD'])}）`;
    const commit = git(['commit-tree', tree, ...parents, '-m', message], env);
    console.log('[3/3] 推送 → private（私有仓库）');
    git(['push', '--force', PRIVATE_REMOTE, `${commit}:refs/heads/main`]);
  } finally {
    rmSync(TMP_INDEX, { force: true });
  }

  console.log('完成：公开与私有仓库均已同步');
}

try {
  main();
} catch (error) {
  console.error(`同步失败：${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
