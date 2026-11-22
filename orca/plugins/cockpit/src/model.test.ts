import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { draftFormat, escapeAskSections, latestAnswer, missingFields, unanswered, nextOp, overlay, parseCockpit, shownTask, UNDO_GRACE_MS, unappliedOps, upgradeCard, type Card, type Cockpit, type Op, type UserLog } from './model.ts'
import { appendOp, notifyMain, readNotified, SIGNAL, signalPlan, signalText, splitLine, writeAtomic, writeNotified } from './store.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const aoba = (): Cockpit => structuredClone(sample(NOW)[0]!.cockpit)
const op = (o: Partial<Op> & Pick<Op, 'op_id' | 'item_id' | 'type'>): Op => ({ at: new Date(NOW).toISOString(), item_rev: 1, ...o })
const statusOf = (c: Cockpit, log: UserLog, id: string) => overlay(c, log).find((v) => v.card.id === id)!

test('操作が無ければ、開いたカードは私の番、開いた話し中（版 2 の talk）は相談として私の番、送ったものは顧客待ち、済んだものは片付いた', () => {
  const c = parseCockpit(JSON.stringify(aoba()))
  const log = { ops: [] }
  assert.equal(statusOf(c, log, 'd21').status, 'mine')
  const c4 = statusOf(c, log, 'c4')
  assert.equal(c4.status, 'mine')
  assert.equal(c4.card.kind, 'consult')
  assert.equal(c4.card.issue, '森さんの回答（明日の午前）を待つ')
  assert.equal(c4.card.stance, '森さんに送った内容で、あとは回答次第で決める感じにしよう。')
  assert.equal(statusOf(c, log, 'w1').status, 'waiting')
  assert.equal(statusOf(c, log, 'd19').status, 'closed')
})

test('決めた操作は担当が受け取るまで「受け取り待ち」で片付いたに入り、受け取ると印が消える', () => {
  const c = aoba()
  const log = { ops: [op({ op_id: 2, item_id: 'd21', type: 'decide', option_id: 'keep' })] }
  const v = statusOf(c, log, 'd21')
  assert.equal(v.status, 'closed')
  assert.equal(v.pending, true)
  assert.equal(v.how, '決定: 図はこのまま、本文で説明する')
  assert.equal(v.undoOp?.op_id, 2)
  // 担当が反映すると cockpit.json の state が正になる。
  c.applied_ops = [1, 2]
  c.cards.find((x) => x.id === 'd21')!.state = 'done'
  Object.assign(c.cards.find((x) => x.id === 'd21')!, { resolved_by: 'user', resolved_option: 'keep' })
  assert.equal(statusOf(c, log, 'd21').pending, false)
})

test('取り消した操作は効かず、カードは私の番に戻る', () => {
  const log = { ops: [op({ op_id: 2, item_id: 'd21', type: 'decide', option_id: 'keep' }), op({ op_id: 3, item_id: 'd21', type: 'undo', undo_of: 2 })] }
  assert.equal(statusOf(aoba(), log, 'd21').status, 'mine')
})

test('古い版に押した操作は効かない（担当が書き換えたら、もう一度私の番になる）', () => {
  const c = aoba()
  c.cards.find((x) => x.id === 'd21')!.rev = 2
  const log = { ops: [op({ op_id: 2, item_id: 'd21', type: 'decide', option_id: 'keep' }), op({ op_id: 3, item_id: 'd21', type: 'talk' })] }
  assert.equal(statusOf(c, log, 'd21').status, 'mine')
})

test('「担当と話す」を押しても私の番に残って話し中の印が付き、担当が書き換えて版が上がると印が消える（R46）', () => {
  const c = aoba()
  const log = { ops: [op({ op_id: 2, item_id: 'd21', type: 'talk' })] }
  const v = statusOf(c, log, 'd21')
  assert.equal(v.status, 'mine')
  assert.deepEqual(v.talking, { since: log.ops[0]!.at })
  // 窓口が受け取っても（applied_ops）、同じ版のあいだは話し中のまま。
  c.applied_ops = [2]
  assert.ok(statusOf(c, log, 'd21').talking)
  c.cards.find((x) => x.id === 'd21')!.rev = 2
  assert.equal(statusOf(c, log, 'd21').talking, undefined)
})

test('見ての直し（本文つき talk）は件数から外れ、受け取り待ち → 受け取ったら直し待ち → 直した版で私の番に戻る', () => {
  const c = aoba()
  const log = { ops: [op({ op_id: 2, item_id: 'r5', type: 'talk', text: '並べ替えの既定を地区にして' })] }
  const v = statusOf(c, log, 'r5')
  assert.equal(v.status, 'fixing')
  assert.equal(v.pending, true)
  assert.equal(v.fix, '並べ替えの既定を地区にして')
  // 受領は applied_ops に足すだけ。カードの中身は変えないので、直し待ちのまま。
  c.applied_ops = [1, 2]
  assert.equal(statusOf(c, log, 'r5').status, 'fixing')
  assert.equal(statusOf(c, log, 'r5').pending, false)
  c.cards.find((x) => x.id === 'r5')!.rev = 2
  assert.equal(statusOf(c, log, 'r5').status, 'mine')
})

test('必須の欄: 共通（仕事・何のため・なぜ今か期限・返事が無いとき・出典）と種類ごとの欄。手作業は何のためと手作業の欄だけ', () => {
  const base: Card = { id: 'x', rev: 1, kind: 'consult', state: 'open', title: 't', stream: 's', purpose: 'p', due: '2026-11-22', fallback: 'f', quote: 'q' }
  assert.deepEqual(missingFields(base).map((m) => m.key), ['issue', 'stance'])
  assert.deepEqual(missingFields({ ...base, issue: 'i', stance: 's' }), [])
  assert.deepEqual(missingFields({ ...base, kind: 'decide', context: { what: 'a', now: 'b', how: 'c', gain: 'd', cost: 'e' }, options: [{ id: 'a', label: 'A', example: 'x', recommended: true }, { id: 'b', label: 'B' }] }).map((m) => m.key), ['options'])
  assert.deepEqual(missingFields({ ...base, kind: 'decide', context: { what: 'a', now: 'b', how: 'c', gain: 'd', cost: 'e' }, options: [{ id: 'a', label: 'A', example: 'x', recommended: true }, { id: 'b', label: 'B', example: 'y', recommended: true }] }).map((m) => m.key), ['options.recommended'])
  const manual: Card = { id: 'p', rev: 1, kind: 'permit', state: 'open', title: 't', purpose: 'p', manual: { where: 'ターミナル', command: 'sudo darwin-rebuild switch' } }
  assert.deepEqual(missingFields(manual).map((m) => m.key), ['manual.check'])
  assert.deepEqual(missingFields({ ...base, kind: 'report' }), [])
  // 送る前は元のスレッドの URL が出典になる。
  assert.deepEqual(missingFields({ ...base, kind: 'send', quote: undefined, draft: { to: 'a', via: 'Slack', text: 't', href: 'https://example.com' } }), [])
})

test('送る文面の書式: format が先、無ければ経路、それでも決まらなければ元のスレッドのリンク。決まらなければ無し', () => {
  const d = { to: 'a', text: 't' }
  assert.equal(draftFormat({ ...d, via: 'Slack・共有チャンネル', format: 'teams' }), 'teams')
  assert.equal(draftFormat({ ...d, via: 'Slack Connect' }), 'slack')
  assert.equal(draftFormat({ ...d, via: 'Teams のチャネル' }), 'teams')
  assert.equal(draftFormat({ ...d, via: 'メール（Gmail）' }), 'mail')
  assert.equal(draftFormat({ ...d, via: '顧客', href: 'https://teams.microsoft.com/l/message/1' }), 'teams')
  assert.equal(draftFormat({ ...d, href: 'mailto:mori@example.com' }), 'mail')
  // リンクはホストを決まったドメインとそのサブドメインだけで見る（パスやほかのサービスの名前に mail が入っていてもメールにしない）。
  assert.equal(draftFormat({ ...d, href: 'https://example.com/mail/1' }), undefined)
  assert.equal(draftFormat({ ...d, via: 'LINE', href: 'https://mailchimp.com/' }), undefined)
  assert.equal(draftFormat({ ...d, href: 'https://acme.slack.com/archives/C1' }), 'slack')
  assert.equal(draftFormat({ ...d, href: 'https://outlook.office.com/mail/inbox' }), 'mail')
  assert.equal(draftFormat({ ...d, via: 'LINE', href: 'not a url' }), undefined)
  // 形の違う format は読み込みで欄ごと外れる（帳簿の欄の形の違いに出る）。
  const c = structuredClone(sample()[0]!.cockpit)
  const card = c.cards.find((x) => x.draft)!
  ;(card.draft as { format?: string }).format = 'line'
  assert.equal(parseCockpit(JSON.stringify(c)).cards.find((x) => x.id === card.id)!.draft, undefined)
})

test('版 2 の古い形を読む: 開いた talk は相談、at が無ければ created_at、worker は dispatch_id だけでも run_id だけでも読む', () => {
  assert.equal(upgradeCard({ id: 'c', rev: 1, kind: 'talk', state: 'done', title: 't' }).kind, 'talk')
  assert.equal(upgradeCard({ id: 'p', rev: 1, kind: 'permit', state: 'open', title: 't', created_at: '2026-11-21T19:31:42+09:00' }).at, '2026-11-21T19:31:42+09:00')
  const c = aoba()
  c.tasks[0]!.worker = { task_id: 'task_1', run_id: 'run_1' }
  assert.deepEqual(parseCockpit(JSON.stringify(c)).tasks[0]!.worker, { task_id: 'task_1', run_id: 'run_1' })
})

test('種類ごとの片付けの言葉: 許すは「許した」、送る前の送ったは「送った」、別の答えは本文', () => {
  const c = sample(NOW)[1]!.cockpit
  const log = { ops: [op({ op_id: 1, item_id: 'p7', type: 'accept' }), op({ op_id: 2, item_id: 'k9', type: 'decide', option_id: 'other', text: '情報部に聞いてから' })] }
  assert.equal(statusOf(c, log, 'p7').how, '許可')
  assert.equal(statusOf(c, log, 'k9').how, '別の回答: 情報部に聞いてから')
  const a = aoba()
  assert.equal(statusOf(a, { ops: [op({ op_id: 2, item_id: 'd22', item_rev: 2, type: 'sent' })] }, 'd22').how, '送信済み')
})

test('cockpit.json は版 2 だけを読み、版 1 は移し替えの手順を添えて断る。形の誤りのカードはその 1 枚だけ外して名指しする', () => {
  assert.doesNotThrow(() => parseCockpit(JSON.stringify(aoba())))
  assert.throws(() => parseCockpit(JSON.stringify({ workspace: { name: 'x' }, streams: [], tasks: [], items: [] })), /migrate\.ts/)
  const bad = { ...aoba(), cards: [{ id: 'x', rev: 1, kind: 'ask', title: 't', state: 'open' }, ...aoba().cards] }
  const problems: string[] = []
  assert.equal(parseCockpit(JSON.stringify(bad), problems).cards.length, aoba().cards.length)
  assert.match(problems.join('\n'), /形の誤り: .*カード x（kind が不正: ask）/)
  assert.throws(() => parseCockpit(JSON.stringify({ ...aoba(), owners: [{ title: 'x' }] })), /owners/)
})

test('未反映の操作と次の op_id', () => {
  const c = aoba()
  const log = { ops: [op({ op_id: 1, item_id: 'd19', type: 'decide' }), op({ op_id: 4, item_id: 'd21', type: 'talk' })] }
  assert.deepEqual(unappliedOps(c, log).map((o) => o.op_id), [4])
  assert.equal(nextOp(log, { at: '', item_id: 'x', item_rev: 1, type: 'ack' }).op_id, 5)
})

test('合図の対象: どの画面が書いた操作も取り消しの猶予（UNDO_GRACE_MS）のあとに送る。未反映の取り消しの組は除く（R191 で送るのは窓だけ）', () => {
  const c = aoba()
  const at = (ms: number) => new Date(NOW - ms).toISOString()
  const log = { ops: [
    { op_id: 2, at: at(UNDO_GRACE_MS + 2000), item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'keep' },
    { op_id: 3, at: at(UNDO_GRACE_MS + 2000), item_id: 'r5', item_rev: 1, type: 'accept' },
    { op_id: 4, at: at(UNDO_GRACE_MS + 1000), item_id: 'r5', item_rev: 1, type: 'undo', undo_of: 3 },
    { op_id: 5, at: at(UNDO_GRACE_MS - 2000), item_id: 'd22', item_rev: 2, type: 'sent' }
  ] as Op[] }
  const plan = signalPlan(c, log, 0, NOW)
  assert.deepEqual(plan.due.map((o) => o.op_id), [2])
  assert.equal(plan.nextAt, Date.parse(at(UNDO_GRACE_MS - 2000)) + UNDO_GRACE_MS)
  // 送った位置は 1 つの数なので、猶予中の操作（5）より後の操作（6）は先に送らない。猶予中の操作の本文も送らない（Codex 追加 44）。
  const later = { ops: [...log.ops, { op_id: 6, at: at(UNDO_GRACE_MS + 2000), item_id: 'd21', item_rev: 1, type: 'talk', text: 'まだ取り消すかも' }] as Op[] }
  assert.deepEqual(signalPlan(c, later, 0, NOW).due.map((o) => o.op_id), [2])
  assert.deepEqual(signalPlan(c, later, 0, Infinity).due.map((o) => o.op_id), [2, 5, 6])
})

test('合図の対象: 「これで決める」（ask_decide）とその取り消しは、窓口の本線に合図を送らない（返しは hook が窓口の Run に知らせる）', () => {
  const c = aoba()
  const at = new Date(NOW - 60_000).toISOString()
  const log = { ops: [
    { op_id: 2, at, item_id: '#ask:ask3', item_rev: 0, type: 'ask_decide', answer: { at: '09:11', head: '1 つ' } },
    { op_id: 3, at, item_id: '#ask:ask3', item_rev: 0, type: 'undo', undo_of: 2 },
    { op_id: 4, at, item_id: '#ask:ask4', item_rev: 0, type: 'ask_decide', answer: { at: '09:12', head: 'x' } },
    { op_id: 5, at, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'keep' }
  ] as Op[] }
  assert.deepEqual(signalPlan(c, log, 0, NOW).due.map((o) => o.op_id), [5])
})

test('合図の 1 行に、担当と話すと別の答えのカードと本文の頭を載せる', () => {
  assert.equal(signalText([op({ op_id: 1, item_id: 'd21', type: 'decide', option_id: 'keep' })]), SIGNAL)
  assert.equal(signalText([op({ op_id: 1, item_id: 'd21', type: 'talk' })]), `${SIGNAL}（担当と話す d21）`)
  assert.equal(signalText([op({ op_id: 1, item_id: '', type: 'repeat' })]), `${SIGNAL}（前にも言った）`)
  assert.equal(signalText([op({ op_id: 1, item_id: 'd21', type: 'decide', option_id: 'other', text: '図は\n描き足す' })]), `${SIGNAL}（別の答え d21: 図は 描き足す）`)
})

test('送った位置は、案件どうしが同時に書いても両方残る（1 つのファイルに持つため。Codex 追加 44）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cockpit-notified-'))
  await Promise.all([writeNotified(dir, '/ws/a', 7), writeNotified(dir, '/ws/b', 9), writeNotified(dir, '/ws/c', 3)])
  assert.deepEqual(await Promise.all(['/ws/a', '/ws/b', '/ws/c'].map((r) => readNotified(dir, r))), [7, 9, 3])
})

test('合図の送り先（R191）: 端末の窓口にもチャットの窓口にも main.run_id の Run に知らせ（本文の頭に案件と操作、書いた文は全文）、run_id が無ければ送らない', async () => {
  const c = aoba()
  const text = '"引用"と\n改行\n--to run:other --body x'
  const log: UserLog = { ops: [op({ op_id: 901, item_id: 'd21', type: 'talk', text })] }
  const sent: string[][] = []
  const sendRun = async (id: string, subject: string, body: string) => (sent.push([id, subject, body]), { sent: true })
  for (const terminal of ['term_main', '']) {
    c.main = { agent: 'claude', terminal, run_id: 'run_1' }
    assert.deepEqual(await notifyMain(c, log.ops, sendRun), { sent: true, lastOp: 901 })
    const [id, subject, body] = sent.pop()!
    assert.deepEqual([id, subject], ['run_1', SIGNAL])
    assert.ok(body!.startsWith(`${c.workspace.name} の操縦席の窓から: ${SIGNAL}（直してほしい d21: `), body)
    assert.ok(body!.includes(`書いた文（全文）:\n${text}`), body)
  }
  c.main = { agent: 'claude', terminal: 'term_main' }
  assert.deepEqual(await notifyMain(c, log.ops, sendRun), { sent: false, reason: 'cockpit.json の main に run_id がありません' })
  assert.deepEqual(sent, [])
  // 送れなかった理由はそのまま返す（窓の上の帯に出す）。
  c.main = { agent: 'claude', terminal: '', run_id: 'run_1' }
  assert.deepEqual(await notifyMain(c, log.ops, async () => { throw new Error('Run が見つかりません') }), { sent: false, reason: 'Run が見つかりません' })
})

test('同じ瞬間に同じファイルを何度書いても、一時ファイルが取り違えられず全部書ける', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'cockpit-atomic-')), 'a.json')
  await Promise.all(Array.from({ length: 20 }, (_, n) => writeAtomic(file, String(n))))
  assert.match(readFileSync(file, 'utf8'), /^\d+$/)
})

test('path:行 をファイルと行に分ける', () => {
  assert.deepEqual(splitLine('docs/設計.md:12'), { file: 'docs/設計.md', line: 12 })
  assert.deepEqual(splitLine('docs/a:b.md'), { file: 'docs/a:b.md' })
})

test('worker の記録があるタスクは Dispatch の様子から、外の相手を待つタスクと記録の無いタスクと Orca を読んでいない画面はメインの state のまま', () => {
  const t = { id: 't', stream: 's', phase: 'p', title: 't', state: 'idle' as const, worker: { task_id: 'task_1', dispatch_id: 'ctx_1' } }
  assert.deepEqual(shownTask(t, { state: 'dispatched', liveness: 'live' }), { state: 'run', why: 'working' })
  assert.deepEqual(shownTask(t, { state: 'succeeded' }), { state: 'wait', why: 'intake' })
  assert.deepEqual(shownTask(t, { state: 'dispatched', liveness: 'exited' }), { state: 'stop', why: 'stopped', stop: 'dead' })
  assert.deepEqual(shownTask(t, { state: 'failed' }), { state: 'stop', why: 'stopped', stop: 'error' })
  assert.deepEqual(shownTask(t, { state: 'dispatched', waiting: true }), { state: 'stop', why: 'stopped', stop: 'blocked' })
  assert.deepEqual(shownTask(t, null), { state: 'stop', why: 'missing' })
  assert.deepEqual(shownTask(t, undefined), { state: 'idle', why: 'record' })
  assert.deepEqual(shownTask({ ...t, state: 'wait' }, { state: 'dispatched' }), { state: 'wait', why: 'record' })
  assert.deepEqual(shownTask({ ...t, state: 'ok' }, null), { state: 'ok', why: 'ok' })
})

test('tasks[].worker は orchestration の形だけを読み、workerctl の頃の形のタスクは外して名指しする', () => {
  const old = aoba() as unknown as { tasks: { worker?: unknown }[] }
  old.tasks[0]!.worker = { worktree_id: 'r::w', terminal: 'term_w' }
  const problems: string[] = []
  assert.equal(parseCockpit(JSON.stringify(old), problems).tasks.length, aoba().tasks.length - 1)
  assert.match(problems.join('\n'), /形の誤り: .*タスク t1（worker の形が不正/)
})

test('操作は押した瞬間のファイルで確かめる: 画面が古くても書き換え後の版には記録せず、片付いたカードと版 1 のファイルにも記録しない', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-append-'))
  mkdirSync(path.join(root, '.orca'))
  const shown = aoba()
  const onDisk = aoba()
  onDisk.cards.find((x) => x.id === 'r5')!.rev = 2
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify(onDisk))
  await assert.rejects(appendOp(root, shown, { root, item_id: 'r5', item_rev: 1, type: 'accept' }), /担当が書き換えました/)
  await assert.rejects(appendOp(root, shown, { root, item_id: 'd19', item_rev: 1, type: 'decide', option_id: 'a' }), /もう片付いています/)
  // 決めて受け取り待ちのカードに、もう一度決める操作を重ねない。
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify({ ...shown, applied_ops: [] }))
  await appendOp(root, shown, { root, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'keep' })
  await assert.rejects(appendOp(root, shown, { root, item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'keep' }), /もう片付いています/)
  await assert.rejects(appendOp(root, shown, { root, item_id: 'w1', item_rev: 2, type: 'sent' }), /もう片付いています/)
  // 「前にも言った」はカードを持たない、案件全体への合図。
  assert.equal((await appendOp(root, shown, { root, item_id: '', item_rev: 0, type: 'repeat' })).ops.at(-1)!.type, 'repeat')
  await assert.rejects(appendOp(root, shown, { root, item_id: 'd21', item_rev: 1, type: 'repeat' }), /カードに付けません/)
  writeFileSync(path.join(root, '.orca', 'cockpit.json'), JSON.stringify({ workspace: { name: 'x' }, streams: [], tasks: [], items: [] }))
  await assert.rejects(appendOp(root, shown, { root, item_id: 'd21', item_rev: 1, type: 'talk' }), /migrate\.ts/)
})

test('深田さんの返答で閉じたカードは、選択肢の記録が無くても種類ごとの返答の名前で出す（担当が片付けたと出さない）', () => {
  const base = { rev: 1, state: 'done' as const, title: 'x', resolved_by: 'user' as const }
  const c = { version: 2, workspace: { name: 'w' }, streams: [], tasks: [], cards: [
    { ...base, id: 'v1', kind: 'review' }, { ...base, id: 'p1', kind: 'permit', resolved_text: 'push だけ' }, { ...base, id: 'v2', kind: 'review', resolved_by: 'owner' }
  ] } as Cockpit
  assert.deepEqual(overlay(c, { ops: [] }).map((v) => v.how), ['承認', '許可: push だけ', '担当が完了'])
})

test('窓から送る質問の中の、控えの節の見出しと同じ形の行だけを 1 字下げる。決める候補は最後の質問より後の答えで、通番を持つ', () => {
  assert.equal(escapeAskSections('例:\n### 答え 09:00\n### 補足\n本文 ### 質問 09:00'), '例:\n ### 答え 09:00\n### 補足\n本文 ### 質問 09:00')
  const q = { kind: 'q' as const, time: '09:10', text: 'q' }
  const a = (time: string, text: string) => ({ kind: 'a' as const, time, text })
  assert.deepEqual(latestAnswer([q, a('09:11', '**1 つ**にする')]), { at: '09:11', head: '1 つにする', n: 1 })
  assert.equal(latestAnswer([q, a('09:11', 'x'), q]), undefined)
  assert.deepEqual(latestAnswer([q, a('09:11', 'x'), q, a('09:11', 'x'), { kind: 'n', time: '09:12', text: '知らせ' }]), { at: '09:11', head: 'x', n: 2 })
  assert.equal(unanswered([q, a('09:11', 'x'), q, { kind: 'n', time: '09:12', text: '知らせ' }]), true)
  assert.equal(unanswered([]), false)
})
