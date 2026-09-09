import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from './store/db.js'
import { Secrets, resolveSecretsPath } from './core/secrets.js'
import { BarkNotifier } from './core/notifier.js'
import { Pipeline } from './core/pipeline.js'
import { Scheduler } from './core/scheduler.js'
import { TOOL_VERSION } from './core/packer.js'

/**
 * CLI 入口：autobackup <command>
 *   run <profileId>   手动备份一个档案
 *   run --all         手动跑全部启用档案
 *   status            查看档案与最近 runs
 *   retention <targetId> <profileId>  手动执行保留裁剪
 *   serve             启动常驻模式（调度器 + Web API）——M3
 */
interface Cli {
  command: string
  args: string[]
}

function parseArgs(argv: string[]): Cli {
  const [command = 'status', ...args] = argv
  return { command, args }
}

async function bootstrap(): Promise<{
  store: Store
  secrets: Secrets
  pipeline: Pipeline
  scheduler: Scheduler
  homeDir: string
  secretsPath: string
}> {
  const homeDir = process.env.AUTOBACKUP_HOME ?? process.cwd()
  mkdirSync(join(homeDir, 'artifacts'), { recursive: true })
  mkdirSync(join(homeDir, 'logs'), { recursive: true })

  const store = new Store(join(homeDir, 'autobackup.db'))
  const secretsPath = resolveSecretsPath(homeDir)
  const secrets = new Secrets(secretsPath)
  const notifier = new BarkNotifier(secrets.getOptional('BARK_URL'))
  const pipeline = new Pipeline({ store, secrets, homeDir, notify: notifier, toolVersion: TOOL_VERSION })
  const scheduler = new Scheduler(store, pipeline)
  return { store, secrets, pipeline, scheduler, homeDir, secretsPath }
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2))
  const ctx = await bootstrap()

  switch (command) {
    case 'run': {
      await ctx.pipeline.recoverStaleRuns()
      const ids = args[0] === '--all' ? ctx.store.listProfiles().map((p) => p.id) : args
      if (ids.length === 0) {
        console.error('usage: autobackup run <profileId|--all>')
        process.exitCode = 2
        break
      }
      let failed = 0
      for (const id of ids) {
        console.log(`▶ backing up ${id} ...`)
        const run = await ctx.scheduler.runNow(id)
        const r = run as { status: string; sizeBytes?: number; error?: string }
        const sizeMb = r.sizeBytes ? `${(r.sizeBytes / 1024 / 1024).toFixed(1)}MB` : ''
        console.log(`  ${r.status === 'success' ? '✅' : '❌'} ${r.status} ${sizeMb} ${r.error ?? ''}`)
        if (r.status !== 'success') failed++
      }
      process.exitCode = failed > 0 ? 1 : 0
      break
    }
    case 'status': {
      const profiles = ctx.store.listProfiles({ includeDrafts: true })
      console.log(`AutoBackup ${TOOL_VERSION} — ${profiles.length} profiles`)
      for (const p of profiles) {
        const runs = ctx.store.listRuns(p.id, 1)
        const last = runs[0]
        const flag = p.isDraft ? ' [draft]' : p.enabled ? '' : ' [disabled]'
        console.log(
          `  ${p.id.padEnd(24)} ${p.kind.padEnd(10)}${flag} last: ${
            last ? `${last.status} ${last.startedAt}` : 'never'
          }`,
        )
      }
      break
    }
    case 'retention': {
      const [targetId, profileId] = args
      if (!targetId || !profileId) {
        console.error('usage: autobackup retention <targetId> <profileId>')
        process.exitCode = 2
        break
      }
      const target = ctx.store.getTarget(targetId)
      const profile = ctx.store.getProfile(profileId)
      if (!target || !profile) {
        console.error('target or profile not found')
        process.exitCode = 2
        break
      }
      const result = await ctx.pipeline.applyRetention(target, profile)
      console.log(`retention done: deleted=${result.deleted} kept=${result.kept}`)
      break
    }
    case 'serve': {
      await ctx.pipeline.recoverStaleRuns()
      ctx.scheduler.start()
      const { startApi } = await import('./server.js')
      const api = await startApi({
        store: ctx.store,
        pipeline: ctx.pipeline,
        scheduler: ctx.scheduler,
        secrets: ctx.secrets,
        secretsPath: ctx.secretsPath,
        port: Number(process.env.AUTOBACKUP_PORT ?? 8199),
      })
      const shutdown = (): void => {
        console.log('\nshutting down...')
        ctx.scheduler.stop()
        void api.stop()
        ctx.store.close()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      // keepalive
      setInterval(() => {}, 1 << 30)
      break
    }
    default:
      console.error(`unknown command: ${command} (run|status|retention|serve)`)
      process.exitCode = 2
  }

  if (command !== 'serve') ctx.store.close()
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
