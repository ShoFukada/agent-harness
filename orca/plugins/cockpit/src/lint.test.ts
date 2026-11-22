// 送る文面の書式の検査（dev-standards の draft-format-lint）を、窓・パネルのコピーの手前で使う形を固定する。CLI は契約どおりに動く偽物に差し替える。
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { FAKE_LINT, FIXED_M1, OLD_M1, REAL_SENDS } from '../fixtures/drafts.ts'
import { sample } from '../fixtures/sample.ts'
import { copyBlock, copyTarget } from './controller.ts'
import { checkDrafts, draftLinter, lintBin } from './lint.ts'
import { parseCockpit, type Card, type DraftCheck } from './model.ts'
import type { CockpitView } from './protocol.ts'
import { boardsOf, newUi, render, type Model } from './view.ts'
import { renderWindow } from './window-view.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'cockpit-lint-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const BIN = path.join(dir, 'draft-format-lint')
writeFileSync(BIN, FAKE_LINT)
chmodSync(BIN, 0o755)
const calls = () => (existsSync(`${BIN}.calls`) ? readFileSync(`${BIN}.calls`, 'utf8').split('\n').filter(Boolean).length : 0)

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const send = (id: string, draft: Card['draft'], over: Partial<Card> = {}): Card => ({ id, rev: 1, kind: 'send', state: 'open', title: '送る', stream: 's1', draft, ...over })

test('検査の CLI: 違反を id ごとに返し、無い・起動できない・終了コード 2 以上・読めない出力は全部の id を error にする（fail closed）', async () => {
  const items = [{ id: 'm1', to: 'slack' as const, text: OLD_M1.text }, { id: 's164', to: 'mail' as const, text: REAL_SENDS.s164.text }]
  const r = await checkDrafts(items, { bin: BIN })
  assert.deepEqual(r.s164, { format: 'mail', violations: [] })
  assert.ok('violations' in r.m1!)
  assert.deepEqual(r.m1.violations.map((v) => [v.line, v.rule]), [[4, 'bullet-symbol'], [5, 'bullet-symbol'], [6, 'bullet-symbol'], [7, 'bullet-symbol']])
  const missing = await checkDrafts(items, { bin: path.join(dir, 'none') })
  assert.match((missing.m1 as { error: string }).error, /を起動できない/)
  assert.ok('error' in missing.s164!, '1 件の失敗で全部を止める')
  for (const [mode, re] of [['broken', /出力を読めない/], ['exit3', /が 3 で終わった/], ['stray', /渡していない id の違反がある/]] as const) {
    const x = await checkDrafts(items, { bin: BIN, env: { ...process.env, FAKE_LINT_MODE: mode } })
    assert.match((x.m1 as { error: string }).error, re)
  }
  assert.deepEqual(await checkDrafts([], { bin: path.join(dir, 'none') }), {}, '検査する文面が無ければ CLI を呼ばない')
  assert.equal(lintBin({ env: { COCKPIT_DRAFT_LINT: '/x/lint' } }), '/x/lint')
  assert.equal(lintBin({ env: {} }), path.join(homedir(), '.claude/plugins/marketplaces/medurance-dev-standards/scripts/draft-format-lint'))
})

test('窓・パネルの検査: 本文と書式の組みで覚えて CLI を呼び直さない。閉じたカードと書式の決まらない宛先は検査しない。検査できなかった結果は 1 分で捨てる', async () => {
  let now = 0
  const lint = draftLinter({ bin: BIN }, () => now)
  const cards = [
    send('m1', OLD_M1), send('s163', REAL_SENDS.s163), send('dup', REAL_SENDS.s163),
    send('done', OLD_M1, { id: 'done', state: 'done' }), send('line', { to: 'a', via: 'LINE', text: '■ x' }),
    send('r9', { ...OLD_M1, format: 'teams' }, { kind: 'review' })
  ]
  const before = calls()
  const r = await lint(cards)
  assert.deepEqual(Object.keys(r).sort(), ['dup', 'm1', 'r9', 's163'])
  assert.equal(r.m1!.format, 'slack', 'format の無い旧 m1 は via から Slack として検査する')
  assert.equal(r.r9!.format, 'teams', '見てはカードの format で検査する')
  assert.equal(calls() - before, 1, '1 回の呼び出しにまとめる')
  await lint(cards)
  await lint([send('m1-again', OLD_M1)])
  assert.equal(calls() - before, 1, '同じ本文と書式は呼び直さない')
  await lint([send('m1', { ...OLD_M1, text: `${OLD_M1.text}\n追記` })])
  assert.equal(calls() - before, 2, '本文が変われば検査し直す')

  // 覚えが上限（500）に届いた次の回でも、覚えていた文面と新しい文面の両方の結果を返す（Codex の指摘 4）。
  const full = draftLinter({ bin: BIN }, () => now)
  await full(Array.from({ length: 500 }, (_, i) => send(`c${i}`, { ...FIXED_M1, text: `本文 ${i}` })))
  const both = await full([send('c0', { ...FIXED_M1, text: '本文 0' }), send('m1', OLD_M1)])
  assert.deepEqual([both.c0, (both.m1 as { violations: unknown[] }).violations.length], [{ format: 'slack', violations: [] }, 4])

  const broken = draftLinter({ bin: path.join(dir, 'later') }, () => now)
  assert.ok('error' in (await broken([send('m1', FIXED_M1)])).m1!)
  writeFileSync(path.join(dir, 'later'), FAKE_LINT)
  chmodSync(path.join(dir, 'later'), 0o755)
  assert.ok('error' in (await broken([send('m1', FIXED_M1)])).m1!, '1 分のあいだは覚えた失敗を返す')
  now += 61_000
  assert.deepEqual((await broken([send('m1', FIXED_M1)])).m1, { format: 'slack', violations: [] }, '1 分を過ぎたら CLI を呼び直す')
})

test('コピーの止め: 違反・検査の結果が無い・検査できないときは理由を返す（素の本文も入れない）。書式の決まらない宛先は止めない', () => {
  const bad: DraftCheck = { format: 'slack', violations: [{ line: 4, rule: 'bullet-symbol', text: '■ 必要なクォータ', fix: '箇条書きは「- 」' }] }
  assert.match(copyBlock(OLD_M1, bad)!, /Slackの書式に合わない行が 1 件あるので、コピーしていません/)
  assert.match(copyBlock(OLD_M1, undefined)!, /書式の確認が済んでいない/)
  assert.match(copyBlock(OLD_M1, { format: 'slack', error: 'CLI が無い' })!, /書式を確認できないので、コピーしていません: CLI が無い/)
  assert.match(copyBlock(OLD_M1, { format: 'teams', violations: [] })!, /済んでいない/, '別の書式の結果では通さない')
  assert.equal(copyBlock(FIXED_M1, { format: 'slack', violations: [] }), undefined)
  assert.equal(copyBlock({ to: 'a', via: 'LINE', text: '■ x' }, undefined), undefined)
  // 見ての「メールの書式でコピー」は、ボタンの書式ではなくカードの書式（slack）の結果で決める（メール向けの記号の外しは clip-draft が持つ）。
  assert.equal(copyBlock(FIXED_M1, { format: 'slack', violations: [] }), undefined)
  assert.equal(copyTarget(FIXED_M1, 'mail')!.format, 'mail')
})

test('カードの表示: 違反の行・規則・直し方を、送る前（窓とパネル）と見ての見本に出す', () => {
  const w = sample(NOW)[0]!
  const c = parseCockpit(JSON.stringify(w.cockpit))
  c.cards.find((x) => x.id === 'd22')!.draft = OLD_M1
  c.cards.find((x) => x.id === 'r5')!.draft = { ...OLD_M1, format: 'slack' }
  const bad: DraftCheck = { format: 'slack', violations: [{ line: 4, rule: 'bullet-symbol', text: '■ 必要なクォータ', fix: '箇条書きは「- 」' }] }
  const v: CockpitView = { state: 'ok', root: '/ws/aoba', cockpit: c, log: structuredClone(w.log), archive: [], figures: {}, errors: [], workers: [], notifiedOp: 0, drafts: { d22: bad, r5: bad } }
  const m: Model = { boards: boardsOf([v], NOW), focused: '/ws/aoba', unseen: [], errors: [] }
  const want = /書式の確認（Slackの書式に合わない行があるのでコピーしない）<\/b><div>4 行目「■ 必要なクォータ」: 箇条書きは「- 」（bullet-symbol）<\/div>/
  for (const id of ['d22', 'r5']) {
    assert.match(renderWindow(m, { ...newUi(), sel: `/ws/aoba#${id}` }, NOW, (x) => x), want, id)
    assert.match(render(m, { ...newUi(), sel: `/ws/aoba#${id}` }, NOW, (x) => x), want, id)
  }
  const ok = { ...v, drafts: { d22: { format: 'slack' as const, violations: [] } } }
  assert.doesNotMatch(render({ ...m, boards: boardsOf([ok], NOW) }, { ...newUi(), sel: '/ws/aoba#d22' }, NOW, (x) => x), /書式の確認/)
})
