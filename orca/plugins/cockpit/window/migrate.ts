// 版 1 の操縦席を版 2 に移し替える入口。メインが自分のワークスペースで 1 回打つ。
// 使い方: node window/migrate.ts <ワークスペースの root>          … 何が何になるかを出すだけ
//         node window/migrate.ts <ワークスペースの root> --write  … 元を cockpit.v1.json に残して書き換える
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { KIND_LABEL, parseUserLog, type Cockpit } from '../src/model.ts'
import { migrate, migrateArchive, type V1 } from '../src/migrate.ts'
import { writeAtomic } from '../src/store.ts'

export type MigrateResult = { cockpit: Cockpit; archive?: { cards: Cockpit['cards'] }; summary: string[]; unapplied: number[] }

export async function plan(root: string): Promise<MigrateResult> {
  const dir = path.join(root, '.orca')
  const v1 = JSON.parse(await fsp.readFile(path.join(dir, 'cockpit.json'), 'utf8')) as V1
  const cockpit = migrate(v1)
  const archiveText = await fsp.readFile(path.join(dir, 'cockpit.archive.json'), 'utf8').catch(() => undefined)
  const archive = archiveText ? migrateArchive(JSON.parse(archiveText), v1) : undefined
  const logText = await fsp.readFile(path.join(dir, 'cockpit.user.json'), 'utf8').catch(() => undefined)
  const applied = new Set(v1.applied_ops ?? [])
  const unapplied = logText ? parseUserLog(logText).ops.filter((o) => !applied.has(o.op_id)).map((o) => o.op_id) : []
  const count = new Map<string, number>()
  for (const c of cockpit.cards) {
    const k = `${KIND_LABEL[c.kind]}${c.state === 'open' ? '（開いている）' : ''}`
    count.set(k, (count.get(k) ?? 0) + 1)
  }
  const summary = [
    `${v1.workspace.name}: items ${v1.items.length} 件 → cards ${cockpit.cards.length} 件`,
    ...[...count].map(([k, n]) => `  ${k} ${n}`),
    ...cockpit.cards.filter((c) => c.state === 'open').map((c) => `  開いている ${c.id}: ${KIND_LABEL[c.kind]}「${c.title}」`)
  ]
  return { cockpit, archive, summary, unapplied }
}

export async function write(root: string, r: MigrateResult): Promise<void> {
  // 未反映の操作は版 1 の項目に押したもの。先にメインが反映してから移す（版 2 では効かなくなるため）。
  if (r.unapplied.length) throw new Error(`未反映の操作があります（op ${r.unapplied.join(', ')}）。メインが反映してから移し替えてください`)
  const dir = path.join(root, '.orca')
  await fsp.copyFile(path.join(dir, 'cockpit.json'), path.join(dir, 'cockpit.v1.json'))
  if (r.archive) await fsp.copyFile(path.join(dir, 'cockpit.archive.json'), path.join(dir, 'cockpit.archive.v1.json'))
  await writeAtomic(path.join(dir, 'cockpit.json'), JSON.stringify(r.cockpit, null, 2) + '\n')
  if (r.archive) await writeAtomic(path.join(dir, 'cockpit.archive.json'), JSON.stringify(r.archive, null, 2) + '\n')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = args.find((a) => !a.startsWith('--'))
  if (!root) {
    console.error('使い方: node migrate.ts <ワークスペースの root> [--write]')
    process.exit(2)
  }
  const abs = path.resolve(root)
  plan(abs)
    .then(async (r) => {
      console.log(r.summary.join('\n'))
      if (!args.includes('--write')) return console.log('（書き換えていません。--write で書き換えます）')
      await write(abs, r)
      console.log(`書き換えました。元は ${path.join(abs, '.orca', 'cockpit.v1.json')}`)
    })
    .catch((e: Error) => {
      console.error(e.message)
      process.exit(1)
    })
}
