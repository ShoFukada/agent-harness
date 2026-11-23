import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { parseCockpit } from './model.ts'
import type { CockpitView } from './protocol.ts'
import { FRESH_WAIT_MS, parseSnap, SEEN_KEY, seenTracker, sinceOf, snapOf } from './since.ts'
import { boardsOf, newUi, type Model } from './view.ts'
import { renderWindow, sinceHtml, todoOrder } from './window-view.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const SEEN = Date.parse('2026-11-21T08:31:00+09:00')

function aoba(edit: (v: CockpitView) => void = () => {}): Model {
  const w = sample(NOW)[0]!
  const v: CockpitView = { state: 'ok', root: '/ws/aoba', cockpit: parseCockpit(JSON.stringify(w.cockpit)), log: structuredClone(w.log), archive: [], figures: {}, errors: [], workers: [], notifiedOp: 0 }
  edit(v)
  return { boards: boardsOf([v], NOW), focused: '/ws/aoba', unseen: [], errors: [] }
}

/** 前に見たあとに、判断が 1 つ出て（d30）、1 つ書き直され（d21 の版が上がる）、確認が済み（r5）、タスクが 1 つ済み（t1）、1 つ足された（t9）。 */
const later = () =>
  aoba((v) => {
    const c = v.cockpit!
    const d21 = c.cards.find((x) => x.id === 'd21')!
    c.cards.push({ ...structuredClone(d21), id: 'd30', title: '一覧の既定の並び', stream: 's1' })
    d21.rev = 2
    c.cards.find((x) => x.id === 'r5')!.state = 'done'
    c.tasks.find((x) => x.id === 't1')!.state = 'ok'
    c.tasks.push({ ...structuredClone(c.tasks.find((x) => x.id === 't2')!), id: 't9', title: '費用の見積もり' })
  })

test('前に見たときからの変化（追加 24）: 出た行は新規、版の上がった行は更新、済んだカードとタスクを数える。変わっていなければ何も付けない', () => {
  const snap = snapOf(aoba().boards[0]!, SEEN)
  const same = sinceOf(snap, aoba().boards[0]!)
  assert.deepEqual({ ...same, at: 0 }, { root: '/ws/aoba', at: 0, rows: {}, tasks: {}, done: 0, fresh: 0, updated: 0 })
  const s = sinceOf(snap, later().boards[0]!)
  assert.equal(s.at, SEEN)
  assert.deepEqual(s.rows, { '/ws/aoba#d30': 'new', '/ws/aoba#d21': 'upd' })
  assert.deepEqual(s.tasks, { t9: 'new' })
  assert.deepEqual([s.done, s.fresh, s.updated], [2, 1, 1], '済は r5 と t1、新しい要対応は d30、更新は d21')
  // 届いた（inbox）は要対応のタブに出さないので、控えにも印にも入れない。
  assert.ok(!Object.keys(snap.rows).some((k) => k.endsWith('#i3')))
})

test('前に見たときからの変化: 修正待ちから戻った行は「更新」で新しい要対応にも数え、題だけ・タスクの題だけが変わっても「更新」、留守の間に出て済んだカードも「済」に数える（Codex 24）', () => {
  const fix = (v: CockpitView) => v.log.ops.push({ op_id: 900, at: '2026-11-21T00:00:00.000Z', item_id: 'r5', item_rev: 1, type: 'talk', text: '図の入口を直して' })
  const before = aoba(fix).boards[0]!
  assert.equal(before.d.fixing.length, 1, '見本の r5 は修正待ち')
  const snap = snapOf(before, SEEN)
  const after = aoba((v) => {
    fix(v)
    const c = v.cockpit!
    c.cards.find((x) => x.id === 'r5')!.rev = 2
    c.cards.find((x) => x.id === 'c4')!.title = 'AWS アカウントの分け方（本番と検証）'
    c.tasks.find((x) => x.id === 't2')!.title = '構成案の図と本文（本番の入口つき）'
    const d21 = c.cards.find((x) => x.id === 'd21')!
    c.cards.push({ ...structuredClone(d21), id: 'd31', state: 'done', resolved_by: 'user', resolved_at: new Date(SEEN + 600_000).toISOString(), resolved_option: d21.options![0]!.id })
    c.cards.push({ ...structuredClone(d21), id: 'd32', state: 'done', resolved_by: 'user', resolved_at: new Date(SEEN - 600_000).toISOString(), resolved_option: d21.options![0]!.id })
    // 控えで要対応だった d21 は、済んだ時刻が控えの時刻より前でも数える（控えが取り込みの遅れた配信で取られた）。
    Object.assign(d21, { state: 'done', resolved_by: 'user', resolved_at: new Date(SEEN - 60_000).toISOString(), resolved_option: d21.options![0]!.id })
  }).boards[0]!
  const s = sinceOf(snap, after)
  assert.equal(s.rows['/ws/aoba#r5'], 'upd')
  assert.equal(s.rows['/ws/aoba#c4'], 'upd', '題だけが変わった行')
  assert.equal(s.tasks.t2, 'upd', '題だけが変わったタスク')
  assert.equal(s.fresh, 1, '修正待ちから戻った r5 はタブの要対応に入った')
  assert.equal(s.done, 2, '前に見たあとに出て済んだ d31 と、控えで要対応だった d21 は数え、前に見る前に済んだ d32 は数えない')
})

test('前に見たときの控えの出し入れ: 前に出たら前の控えを比べる元に固定し、前に出た時刻の今を次の控えに書く。描いている案件だけを書き、後ろに回ったら書かない', () => {
  const mem = new Map<string, string>()
  const store = { get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => void mem.set(k, v) }
  const b0 = aoba().boards[0]!
  const b1 = later().boards[0]!
  const at = (root = '/ws/aoba') => (mem.has(SEEN_KEY + root) ? JSON.parse(mem.get(SEEN_KEY + root)!).at : undefined)
  const kiri = aoba((v) => (v.root = '/ws/kiri')).boards[0]!
  // 前に出たまま起動した。最初の配信が遅れて来ても、控えの時刻は起動した時刻（Codex 24 の 2 巡目）。
  const t = seenTracker(store, true, SEEN)
  t.feed()
  assert.equal(t.since(b0, SEEN + 3000), undefined, '初めて見た案件は比べる元が無いので印を出さない')
  assert.equal(at(), SEEN)
  t.blur(true)
  // 隠れているあいだに変わった。描いても書かない。
  t.since(b1, SEEN + 3600_000)
  assert.equal(at(), SEEN)
  // 隠れていた窓が前に出た。前の控えと比べて印を出す。繋ぎ直した最初の配信は古いことがあるので、待ちを過ぎるまで書かない。
  t.focus(NOW)
  const s = t.since(b1, NOW)!
  assert.equal(s.at, SEEN)
  assert.deepEqual(s.rows, { '/ws/aoba#d30': 'new', '/ws/aoba#d21': 'upd' })
  t.feed()
  t.since(b1, NOW + 100)
  // 書く前に別の案件に切り替えても、その案件の控えも待つ（Codex 24 の 2 巡目）。
  t.since(kiri, NOW + 200)
  assert.deepEqual([at(), at('/ws/kiri')], [SEEN, undefined], '配信を受けても、待ちの前は書かない')
  // 案件を行き来しても、前に出ているあいだ比べる元は変えない（Codex 24 の 2 巡目）。
  assert.equal(t.since(b1, NOW + FRESH_WAIT_MS)!.at, SEEN)
  assert.equal(at(), NOW, '控えの時刻は前に出た時刻')
  t.since(kiri, NOW + FRESH_WAIT_MS + 100)
  assert.equal(at('/ws/kiri'), NOW + 200, 'あとから切り替えた案件の控えの時刻は、描いた時刻')
  assert.equal(t.since(b1, NOW + 60_000)!.at, SEEN, '行き来しても比べる元は前に出たときに読んだもの')
  t.focus(NOW + 70_000)
  assert.equal(t.since(b1, NOW + 70_000)!.at, SEEN, '前に出ているあいだの重ねた focus では比べる元を変えない')
  // 見えたまま後ろに回り、戻ってすぐまた後ろに回った。配信が切れていないので、戻った時点で書く（Codex 24 の 2 巡目）。
  t.blur(false)
  t.focus(NOW + 90_000)
  assert.equal(t.since(b1, NOW + 90_000)!.at, NOW, '比べる元は前の控え')
  t.blur(false)
  assert.equal(at(), NOW + 90_000)
  // 描いていない案件は書かない（見ていない案件の変化を既読にしない）。
  assert.deepEqual([...mem.keys()].sort(), [SEEN_KEY + '/ws/aoba', SEEN_KEY + '/ws/kiri'])
})

test('前に見たときの控え: 壊れた値・形の違う値・ありえない時刻は捨てる', () => {
  const ok = { at: 1, rows: { 'a#d1': [1, 1, '題'] }, tasks: { t1: '0[]' } }
  assert.deepEqual(parseSnap(JSON.stringify(ok), NOW), ok)
  for (const bad of [null, '{壊れた', JSON.stringify({ ...ok, at: 1e20 }), JSON.stringify({ ...ok, at: 'x' }), JSON.stringify({ ...ok, rows: { 'a#d1': 1 } }), JSON.stringify({ ...ok, tasks: { t1: null } }), JSON.stringify({ ...ok, tasks: { t1: 'x' } }), JSON.stringify({ at: 1 })])
    assert.equal(parseSnap(bad, NOW), undefined, String(bad))
})

test('前に見たときからの変化: 上の帯は語つきの数で 1 行、0 の語は出さず、全部 0 なら出さない。一覧の行に「新規」「更新」の印', () => {
  const m = later()
  const since = sinceOf(snapOf(aoba().boards[0]!, SEEN), m.boards[0]!)
  assert.equal(sinceHtml(since, '/ws/aoba', NOW), '<div class="wsince" role="status"><b>08:31 以降</b>済 2 件・新しい要対応 1 件・更新 1 件</div>')
  assert.equal(sinceHtml({ ...since, done: 0, updated: 0 }, '/ws/aoba', NOW), '<div class="wsince" role="status"><b>08:31 以降</b>新しい要対応 1 件</div>')
  assert.equal(sinceHtml({ ...since, done: 0, fresh: 0, updated: 0 }, '/ws/aoba', NOW), '')
  assert.equal(sinceHtml(since, '/ws/other', NOW), '', '別の案件の控えでは出さない')
  assert.match(sinceHtml({ ...since, at: SEEN - 86400_000 }, '/ws/aoba', NOW), /<b>昨日 08:31 以降<\/b>/)
  const ui = { ...newUi(), since }
  ui.sel = todoOrder(m.boards[0])[0]
  const todo = renderWindow(m, ui, NOW, (x) => x)
  assert.match(todo, /<div class="wsince" role="status">/)
  // 印は題に割り込まないよう 2 行目の先頭に置く。
  assert.match(todo, /data-sel="\/ws\/aoba#d30"[^>]*>[\s\S]*?<span class="ti">一覧の既定の並び<\/span><\/span><span class="recm"><span class="tag new">新規<\/span>・おすすめ: /)
  assert.match(todo, /data-sel="\/ws\/aoba#d21"[^>]*>[\s\S]*?<span class="tag new">更新<\/span>/)
  assert.doesNotMatch(todo.replace(/data-sel="\/ws\/aoba#d(30|21)"[\s\S]*?<\/button>/g, ''), /class="tag new"/, 'ほかの行には付けない')
  const whole = renderWindow(m, { ...ui, tab: 'whole', open: { 's:s2': true } }, NOW, (x) => x)
  assert.match(whole, /data-task="t9"[\s\S]*?費用の見積もり<span class="tag new">新規<\/span>/)
  // 控えが無ければ（初めて開いた窓・保存できないブラウザ）帯も印も出さない。
  assert.doesNotMatch(renderWindow(m, { ...ui, since: undefined }, NOW, (x) => x), /wsince|tag new/)
})
