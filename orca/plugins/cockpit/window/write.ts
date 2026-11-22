import { constants as fsConstants, promises as fsp } from 'node:fs'
import path from 'node:path'
import { parseCockpit, parseUserLog, VERSION, type Cockpit, type UserLog } from '../src/model.ts'
import { lockCockpit, parseUtterances, readInOrca, writeAtomic } from '../src/store.ts'
import { checkDrafts, type LintOpts } from '../src/lint.ts'
import { applyChange, draftsToLint, migrateV3, type MigrateV3, type WriteResult } from '../src/write.ts'
import { orcaCli } from './server.ts'

async function readLedger(root: string): Promise<{ raw: Cockpit; log: UserLog; utterances: ReturnType<typeof parseUtterances> }> {
  const text = await readInOrca(root, '.orca/cockpit.json')
  if (text === undefined) throw new Error(`${root}/.orca/cockpit.json がない`)
  // 書き戻すのは読み込み（parseCockpit）を通す前の中身。読み込みは形の誤りのカードを外すので、通した中身を書くと消える。
  const raw = JSON.parse(text) as Cockpit
  if (raw.version !== VERSION) throw new Error(`cockpit.json の version が ${String(raw.version)}。先に node window/migrate.ts で版 2 にする`)
  const logText = await readInOrca(root, '.orca/cockpit.user.json')
  const uText = await readInOrca(root, '.orca/cockpit/utterances.jsonl')
  return { raw, log: logText ? parseUserLog(logText) : { ops: [] }, utterances: uText ? parseUtterances(uText) : [] }
}

const save = (root: string, c: Cockpit) => writeAtomic(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(c, null, 2) + '\n')

/** 変更を検査して書く。check なら書かない。書いた中身が読み込みで新しい形の誤りを出すなら書かない。lintOpts は書式の検査の CLI の差し替え（試験用）。 */
export async function write(root: string, change: unknown, check = false, lintOpts: LintOpts = {}): Promise<WriteResult> {
  // 送る文面の書式の検査（dev-standards の draft-format-lint）はロックの外で済ませる。ロックは 10 秒で外れるので、中で CLI を待つと並んだ書き込みを古い中身で上書きしうる。
  const lint = await checkDrafts(draftsToLint(change), lintOpts)
  // 検査だけ（--dry-run）はロックファイルも作らない（実データの .orca に何も書かずに通せるように）。
  const release = check ? async () => {} : await lockCockpit(root)
  try {
    const { raw, log, utterances } = await readLedger(root)
    const before: string[] = []
    parseCockpit(JSON.stringify(raw), before)
    const r = applyChange(raw, change, utterances, log, lint)
    if (!r.next) return r
    const after: string[] = []
    parseCockpit(JSON.stringify(r.next), after)
    const fresh = after.filter((p) => !before.includes(p))
    if (fresh.length) return { errors: fresh, warnings: r.warnings }
    if (!check) await save(root, r.next)
    return { ...r, warnings: [...r.warnings, ...before.map((p) => `書く前からある: ${p}`)] }
  } finally {
    await release()
  }
}

/**
 * 版 3 へ移す。write なら元を cockpit.v2.json に控えて書く（控えが既にあれば上書きしない）。書かないときはロックも取らない。
 * Orca への問い合わせ（worker ごとに数秒）はロックの外で先に済ませる。ロックは 10 秒で外れるので、中で待つと
 * 並んで書いた変更を古い中身で上書きしうる。
 */
export async function migrate(root: string, runOf: (dispatch: string) => Promise<string | undefined>, doWrite = false, now = Date.now()): Promise<MigrateV3> {
  const runs: Record<string, string> = {}
  for (const t of (await readLedger(root)).raw.tasks)
    if (t.worker?.dispatch_id && !t.worker.run_id) {
      const run = await runOf(t.worker.dispatch_id).catch(() => undefined)
      if (run) runs[t.worker.dispatch_id] = run
    }
  const release = doWrite ? await lockCockpit(root) : async () => {}
  try {
    const { raw, log, utterances } = await readLedger(root)
    if (raw.intake) throw new Error('すでに版 3 の形（intake がある）')
    const r = migrateV3(raw, log, utterances, runs, now)
    const problems: string[] = []
    parseCockpit(JSON.stringify(r.next), problems)
    if (problems.length) r.summary.push(...problems.map((p) => `読み込みの知らせ: ${p}`))
    if (doWrite) {
      const dir = path.join(root, '.orca')
      await fsp.copyFile(path.join(dir, 'cockpit.json'), path.join(dir, 'cockpit.v2.json'), fsConstants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e
      })
      await save(root, r.next)
    }
    return r
  } finally {
    await release()
  }
}

async function readChange(arg: string): Promise<unknown> {
  const text = arg === '-' ? await new Promise<string>((resolve) => {
    let s = ''
    process.stdin.setEncoding('utf8').on('data', (d) => (s += d)).on('end', () => resolve(s))
  }) : await fsp.readFile(arg, 'utf8')
  return JSON.parse(text)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const plain = args.filter((a) => !a.startsWith('--'))
  const dry = args.includes('--check') || args.includes('--dry-run')
  const fail = (e: Error) => {
    console.error(e.message)
    process.exit(1)
  }
  if (plain[0] === 'migrate-v3' && plain.length <= 2) {
    const doWrite = args.includes('--write')
    if (doWrite && dry) {
      console.error('--write と --dry-run は一緒に使えない（書かずに確かめるなら --write を外す）')
      process.exit(2)
    }
    const orca = orcaCli(process.env.COCKPIT_ORCA ?? 'orca')
    migrate(path.resolve(plain[1] ?? '.'), async (d) => (await orca.show(d))?.dispatch?.runId ?? undefined, doWrite).then((r) => {
      console.log(r.summary.join('\n'))
      if (r.sort.length) console.log(`\n窓口が仕分ける古い依頼（id・題・タスク・最後の更新）:\n${r.sort.map((x) => `  ${x.id} ${x.title}｜${x.tasks}｜${x.last ?? '—'}`).join('\n')}`)
      console.log(doWrite ? '\n書き換えた。元は .orca/cockpit.v2.json' : '\n（書き換えていない。--write で書き換える）')
    }, fail)
  } else if (plain.length === 1 || plain.length === 2) {
    readChange(plain[1] ?? '-').then((ch) => write(path.resolve(plain[0]!), ch, dry)).then((r) => {
      for (const w of r.warnings) console.log(`注意: ${w}`)
      if (r.errors.length) {
        console.error(`書いていない:\n${r.errors.map((e) => `  ${e}`).join('\n')}`)
        process.exit(1)
      }
      console.log(dry ? '検査を通った（書いていない）' : '書いた')
    }, fail)
  } else {
    console.error('使い方: cockpit-write <ワークスペースの root> [変更の JSON ファイル | -] [--dry-run]\n        cockpit-write migrate-v3 [ワークスペースの root] [--write]')
    process.exit(2)
  }
}
