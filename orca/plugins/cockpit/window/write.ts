import { constants as fsConstants, promises as fsp } from 'node:fs'
import path from 'node:path'
import { parseArchive, parseCockpit, parseUserLog, RUN_ID, VERSION, type Card, type Cockpit, type UserLog } from '../src/model.ts'
import { workspaceNameCheck } from '../src/state.ts'
import { lockCockpit, parseUtterances, readInOrca, writeAtomic } from '../src/store.ts'
import { checkDrafts, type LintOpts } from '../src/lint.ts'
import { checkDefer, type DeferOpts } from '../src/defer.ts'
import { applyChange, deferToCheck, draftsToLint, migrateFacts, migrateV3, withBasis, type MigrateFacts, type MigrateV3, type WriteResult } from '../src/write.ts'
import { orcaCli } from './server.ts'

type Utterances = ReturnType<typeof parseUtterances>
async function readLedger(root: string): Promise<{ raw: Cockpit; log: UserLog; utterances: Utterances; notices: Utterances; archive: Card[] }> {
  const text = await readInOrca(root, '.orca/cockpit.json')
  if (text === undefined) throw new Error(`${root}/.orca/cockpit.json がない`)
  // 書き戻すのは読み込み（parseCockpit）を通す前の中身。読み込みは形の誤りのカードを外すので、通した中身を書くと消える。
  const raw = JSON.parse(text) as Cockpit
  if (raw.version !== VERSION) throw new Error(`cockpit.json の version が ${String(raw.version)}。先に node window/migrate.ts で版 2 にする`)
  const logText = await readInOrca(root, '.orca/cockpit.user.json')
  const uText = await readInOrca(root, '.orca/cockpit/utterances.jsonl')
  // 知らせ（hook が Orca の知らせを書く）と片付けたカード（承認で済になったタスクの判定に要る）も、窓と同じ判定のために読む。
  const nText = await readInOrca(root, '.orca/cockpit/notices.jsonl')
  const aText = await readInOrca(root, '.orca/cockpit.archive.json')
  let archive: Card[] = []
  try {
    archive = aText ? parseArchive(aText).cards : []
  } catch {
    archive = []
  }
  return { raw, log: logText ? parseUserLog(logText) : { ops: [] }, utterances: uText ? parseUtterances(uText) : [], notices: nText ? parseUtterances(nText) : [], archive }
}

const save = (root: string, c: Cockpit) => writeAtomic(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(c, null, 2) + '\n')

/**
 * 変更を検査して書く。check なら書かない。書いた中身が読み込みで新しい形の誤りを出すなら書かない。
 * lintOpts・deferOpts は書式の検査・先送りの検査の CLI の差し替え（試験用）。
 */
export async function write(root: string, change: unknown, check = false, lintOpts: LintOpts = {}, deferOpts: DeferOpts = {}): Promise<WriteResult> {
  // 送る文面の書式の検査（dev-standards の draft-format-lint）と先送りの検査（defer-guard.py）はロックの外で済ませる。ロックは 10 秒で外れるので、中で CLI を待つと並んだ書き込みを古い中身で上書きしうる。
  const [lint, defer] = await Promise.all([checkDrafts(draftsToLint(change), lintOpts), checkDefer(deferToCheck(change), deferOpts)])
  // 検査だけ（--dry-run）はロックファイルも作らない（実データの .orca に何も書かずに通せるように）。
  const release = check ? async () => {} : await lockCockpit(root)
  try {
    const { raw, log, utterances, notices, archive } = await readLedger(root)
    const before: string[] = []
    parseCockpit(JSON.stringify(raw), before)
    const r = applyChange(raw, change, utterances, log, lint, defer, { notices, archive, now: Date.now() })
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
    const name = workspaceNameCheck(raw.workspace?.name)
    if (name && doWrite) throw new Error(`移し替えていない: ${name.message}`)
    const r = migrateV3(raw, log, utterances, runs, now)
    if (name) r.summary.unshift(`${name.message}（--write は直すまで断る）`)
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

/**
 * 待ちと済を事実から決める形（R204）へ移す（migrate-facts）。write なら元を cockpit.v3.json に控えて書く（控えが既にあれば上書きしない）。
 * 書かないときはロックも取らず、意味の変わる行の一覧だけを返す（窓口が原文と証拠で照合してから書く）。
 */
export async function migrateToFacts(root: string, doWrite = false, now = Date.now()): Promise<MigrateFacts> {
  const release = doWrite ? await lockCockpit(root) : async () => {}
  try {
    const { raw, log, archive } = await readLedger(root)
    const r = migrateFacts(raw, log, archive, now)
    const problems: string[] = []
    parseCockpit(JSON.stringify(r.next), problems)
    if (problems.length) r.summary.push(...problems.map((p) => `読み込みの知らせ: ${p}`))
    if (doWrite) {
      const dir = path.join(root, '.orca')
      // 控えは上書きしない。戻して直した帳簿をもう一度移すときは、前の控えと中身が違えば時刻つきの別の控えにする（Astra 4 の中 3）。
      const src = path.join(dir, 'cockpit.json')
      const body = await fsp.readFile(src, 'utf8')
      let backup = path.join(dir, 'cockpit.v3.json')
      const prev = await fsp.readFile(backup, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? undefined : Promise.reject(e)))
      if (prev !== undefined && prev !== body) backup = path.join(dir, `cockpit.v3-${new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`)
      if (prev === undefined || prev !== body) await fsp.copyFile(src, backup, fsConstants.COPYFILE_EXCL)
      r.summary.push(`元の控え: ${backup}（戻すときはこれを .orca/cockpit.json に写す）`)
      await save(root, r.next)
    }
    return r
  } finally {
    await release()
  }
}

/**
 * 操縦席を初めて作る（cockpit skill の references/setup.md の「最初に作るとき」）。帳簿が既にあれば断る。
 * 版・案件の名前の形（R165）・窓口の Run（R191）・読み込みの形の誤り・タスクの検査（待ちの書き方 R193 など）のどれかが通らなければ書かず、理由を返す。
 */
export async function init(root: string, ledger: unknown, check = false, deferOpts: DeferOpts = {}): Promise<string[]> {
  if (typeof ledger !== 'object' || ledger === null || Array.isArray(ledger)) return ['帳簿は JSON のオブジェクトで渡す']
  const c = ledger as Partial<Cockpit>
  const errors: string[] = []
  if (c.version !== VERSION) errors.push(`version は ${VERSION}`)
  const name = workspaceNameCheck(c.workspace?.name, '渡す帳簿の workspace.name を直して init し直す（R165）')
  if (name) errors.push(name.message)
  if (!RUN_ID(c.main?.run_id)) errors.push('main.run_id が無い。窓口の Run（orca orchestration run-current の runId）を書く（窓の合図は窓口の Run にだけ送る）')
  if (!errors.length) {
    try {
      parseCockpit(JSON.stringify(c), errors)
    } catch (e) {
      errors.push((e as Error).message)
    }
  }
  // 普通の書き込みは同じ id の行を後の行で置き換えるが、init は渡した中身をそのまま書くので、重なりを断る（重なった先の行が検査をすり抜けるため。Codex 48 の 2 巡目）。
  for (const k of ['streams', 'tasks', 'cards', 'requests', 'owners'] as const) {
    const ids = ((c[k] ?? []) as { id?: unknown }[]).map((x) => x?.id)
    const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
    if (dup.length) errors.push(`${k} に同じ id の行が重なっている: ${dup.join('・')}`)
  }
  // タスクは全部が新しい行なので、普通の書き込みと同じ検査（待ちの書き方・言い回しなど）にかける。先送りの検査はロックの外で済ませる（Codex 48 必須 2）。
  if (!errors.length) {
    const tasks = { tasks: c.tasks }
    const defer = await checkDefer(deferToCheck(tasks), deferOpts)
    errors.push(...applyChange({ ...(c as Cockpit), tasks: [] }, tasks, [], { ops: [] }, {}, defer).errors)
  }
  if (errors.length) return errors
  const exists = [`${root}/.orca/cockpit.json が既にある。書き換えは cockpit-write <root> <変更> で渡す`]
  if (check) return (await readInOrca(root, '.orca/cockpit.json')) !== undefined ? exists : []
  await fsp.mkdir(path.join(root, '.orca'), { recursive: true })
  const release = await lockCockpit(root)
  try {
    if (await readInOrca(root, '.orca/cockpit.json') !== undefined) return exists
    // 初めて作る帳簿は、はじめから待ちと済を事実から決める形にし、渡した状況の文を今の事実の控えで押す（Astra 4 の重大 4）。
    const now = Date.now()
    await save(root, withBasis({ ...(c as Cockpit), facts_since: new Date(now).toISOString() }, { ops: [] }, [], now))
    return []
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
  } else if (plain[0] === 'migrate-facts' && plain.length <= 2) {
    const doWrite = args.includes('--write')
    if (doWrite && dry) {
      console.error('--write と --dry-run は一緒に使えない（書かずに確かめるなら --write を外す）')
      process.exit(2)
    }
    migrateToFacts(path.resolve(plain[1] ?? '.'), doWrite).then((r) => {
      console.log(r.summary.join('\n'))
      if (r.rows.length) console.log(`\n意味の変わる行（id・題｜前｜後｜理由）:\n${r.rows.map((x) => `  ${x.conflict ? '【決める】' : ''}${x.id} ${x.title}｜${x.before}｜${x.after}｜${x.why}`).join('\n')}`)
      console.log(doWrite ? '\n書き換えた（元の控えは上の要約）。次の書き込みで、仕事の status を照合して全部渡す' : '\n（書き換えていない。照合してから --write で書き換える）')
    }, fail)
  } else if (plain[0] === 'init' && (plain.length === 2 || plain.length === 3)) {
    readChange(plain[2] ?? '-').then((c) => init(path.resolve(plain[1]!), c, dry)).then((errors) => {
      if (errors.length) {
        console.error(`作っていない:\n${errors.map((e) => `  ${e}`).join('\n')}`)
        process.exit(1)
      }
      console.log(dry ? '検査を通った（作っていない）' : '作った')
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
    console.error('使い方: cockpit-write <ワークスペースの root> [変更の JSON ファイル | -] [--dry-run]\n        cockpit-write init <ワークスペースの root> [帳簿の JSON ファイル | -] [--dry-run]\n        cockpit-write migrate-v3 [ワークスペースの root] [--write]\n        cockpit-write migrate-facts [ワークスペースの root] [--write]')
    process.exit(2)
  }
}
