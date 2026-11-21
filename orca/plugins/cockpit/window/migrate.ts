// 版 1 の操縦席を版 2 に移し替える入口。メインが自分のワークスペースで 1 回打つ。
// 使い方: node window/migrate.ts <ワークスペースの root>          … 何が何になるかを出すだけ
//         node window/migrate.ts <ワークスペースの root> --write  … 元を cockpit.v1.json に残して書き換える
import { constants as fsConstants, promises as fsp } from 'node:fs'
import path from 'node:path'
import { KIND_LABEL, parseUserLog, VERSION, type Cockpit } from '../src/model.ts'
import { migrate, migrateArchive, oldWorkers, type V1 } from '../src/migrate.ts'
import { lockLog, writeAtomic } from '../src/store.ts'

export type MigrateResult = { cockpit?: Cockpit; archive?: { cards: Cockpit['cards'] }; summary: string[]; unapplied: number[] }

const readJson = (file: string) => fsp.readFile(file, 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>, () => undefined)

/**
 * 移す中身を作る。cockpit.json と cockpit.archive.json は別に判定し、途中で止まったときは残りだけを移す
 * （cockpit.json が版 2 なら、版 1 の中身は cockpit.v1.json から読む）。
 */
export async function plan(root: string): Promise<MigrateResult> {
  const dir = path.join(root, '.orca')
  const current = await readJson(path.join(dir, 'cockpit.json'))
  if (!current) throw new Error(`${path.join(dir, 'cockpit.json')} が読めません`)
  const done = current.version === VERSION
  const v1 = (done ? await readJson(path.join(dir, 'cockpit.v1.json')) : current) as V1 | undefined
  const archiveJson = await readJson(path.join(dir, 'cockpit.archive.json'))
  const archiveTodo = Array.isArray(archiveJson?.items)
  if (done && !archiveTodo) throw new Error('すでに版 2 です')
  if (!v1) throw new Error('cockpit.json は版 2 ですが、cockpit.v1.json がありません')
  const cockpit = done ? undefined : migrate(v1)
  const archive = archiveTodo ? migrateArchive(archiveJson as { items: V1['items'] }, v1) : undefined
  const unapplied = done ? [] : await unappliedOf(dir, v1)
  const count = new Map<string, number>()
  for (const c of cockpit?.cards ?? []) {
    const k = `${KIND_LABEL[c.kind]}${c.state === 'open' ? '（開いている）' : ''}`
    count.set(k, (count.get(k) ?? 0) + 1)
  }
  const summary = [
    ...(cockpit ? [`${v1.workspace.name}: items ${v1.items.length} 件 → cards ${cockpit.cards.length} 件`] : [`${v1.workspace.name}: cockpit.json は移し替え済み`]),
    ...[...count].map(([k, n]) => `  ${k} ${n}`),
    ...(cockpit?.cards ?? []).filter((c) => c.state === 'open').map((c) => `  開いている ${c.id}: ${KIND_LABEL[c.kind]}「${c.title}」`),
    ...(archive ? [`  archive: ${archive.cards.length} 件`] : []),
    ...(cockpit && oldWorkers(v1).length ? [`  workerctl の形の worker の記録を外した、済んでいないタスク: ${oldWorkers(v1).join(', ')}（続けるなら orchestration で立て直し、tasks[].worker に { task_id, dispatch_id } を書く）`] : [])
  ]
  return { cockpit, archive, summary, unapplied }
}

async function unappliedOf(dir: string, v1: V1): Promise<number[]> {
  const logText = await fsp.readFile(path.join(dir, 'cockpit.user.json'), 'utf8').catch(() => undefined)
  const applied = new Set(v1.applied_ops ?? [])
  return logText ? parseUserLog(logText).ops.filter((o) => !applied.has(o.op_id)).map((o) => o.op_id) : []
}

/** 元を *.v1.json に残す。既にあれば上書きしない（2 回目に移し替え後の中身で元を消さないため）。 */
async function backup(from: string, to: string): Promise<void> {
  try {
    await fsp.copyFile(from, to, fsConstants.COPYFILE_EXCL)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const kept = await readJson(to)
    if (kept?.version === VERSION || Array.isArray(kept?.cards)) throw new Error(`${to} が版 2 の中身です。元の版 1 を置き直してから移し替えてください`)
  }
}

/**
 * 書き換える。操作の追記と同じロックの中で、今のファイルから移す中身を作り直して書く
 * （plan のあとに画面で押された操作や、窓口が反映した結果を古い中身で消さないため）。r は確かめに見せた中身で、書くのは作り直したもの。
 */
export async function write(root: string, _shown?: MigrateResult): Promise<MigrateResult> {
  const dir = path.join(root, '.orca')
  const release = await lockLog(root)
  try {
    const r = await plan(root)
    // 未反映の操作は版 1 の項目に押したもの。先にメインが反映してから移す（版 2 では効かなくなるため）。
    if (r.unapplied.length) throw new Error(`未反映の操作があります（op ${r.unapplied.join(', ')}）。メインが反映してから移し替えてください`)
    if (r.cockpit) await backup(path.join(dir, 'cockpit.json'), path.join(dir, 'cockpit.v1.json'))
    if (r.archive) await backup(path.join(dir, 'cockpit.archive.json'), path.join(dir, 'cockpit.archive.v1.json'))
    // archive を先に書く。cockpit.json が版 2 になったら済んだ印なので、最後に書く。
    if (r.archive) await writeAtomic(path.join(dir, 'cockpit.archive.json'), JSON.stringify(r.archive, null, 2) + '\n')
    if (r.cockpit) await writeAtomic(path.join(dir, 'cockpit.json'), JSON.stringify(r.cockpit, null, 2) + '\n')
    return r
  } finally {
    await release()
  }
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
