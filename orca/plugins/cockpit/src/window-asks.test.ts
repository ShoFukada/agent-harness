import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { answerHead, answerParts, parseCockpit, type AskThread, type Op } from './model.ts'
import type { CockpitView } from './protocol.ts'
import { boardsOf, newUi, type Model, type Ui } from './view.ts'
import { renderWindow, todoOrder } from './window-view.ts'
import { answeredCount, askKey, askOpened, askRows, askStarted, askStatus, parseAskKey, shownAskRows, waitId } from './window-asks.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const R = '/ws/aoba'

function aoba(edit: (v: CockpitView) => void = () => {}): Model {
  const w = sample(NOW)[0]!
  const v: CockpitView = { state: 'ok', root: R, cockpit: parseCockpit(JSON.stringify(w.cockpit)), log: structuredClone(w.log), archive: [], figures: {}, errors: [], workers: [], notifiedOp: 0 }
  edit(v)
  return { boards: boardsOf([v], NOW), focused: R, unseen: [], errors: [] }
}
const page = (m: Model, over: Partial<Ui> = {}) => {
  const ui = { ...newUi(), ...over }
  ui.sel ??= todoOrder(m.boards[0])[0]
  return renderWindow(m, ui, NOW, (s) => s)
}
const ask = (id: string, over: Partial<AskThread> = {}): AskThread => ({
  id, path: `${R}/.orca/consult/ask-${id}.md`, returnsPath: `${R}/.orca/consult/ask-${id}.returns.jsonl`, at: '09:05', answers: 0, entries: [], returns: [], ...over
})
const q = (time: string, t: string) => ({ kind: 'q' as const, time, text: t })
const a = (time: string, t: string) => ({ kind: 'a' as const, time, text: t })
const answered = (id: string, over: Partial<AskThread> = {}) =>
  ask(id, { answers: 1, entries: [q('09:10', `${id} の質問`), a('09:11', `${id} の答え`)], decide: { at: '09:11', head: `${id} の答え`, n: 1 }, first: `${id} の質問`, ...over })
const decide = (op: number, id: string, over: Partial<Op> = {}): Op =>
  ({ op_id: op, at: '2026-11-21T09:12:00+09:00', item_id: `#ask:${id}`, item_rev: 0, type: 'ask_decide', answer: { at: '09:11', head: `${id} の答え`, n: 1 }, ...over })
const at = (min: number) => new Date(NOW - min * 60_000).toISOString()

test('やりとりの状態は 4 つの語: 答え待ち・答えあり・反映待ち（写しに届いていないものも）・反映済み', () => {
  const st = (edit: (v: CockpitView) => void, ui: Partial<Ui> = {}) => {
    const b = aoba(edit).boards[0]!
    return askStatus(b, b.v.asks![0]!, { ...newUi(), ...ui })
  }
  assert.equal(st((v) => (v.asks = [ask('ask1', { entries: [q('09:10', '入口は？')] })])).state, 'wait')
  assert.equal(st((v) => (v.asks = [answered('ask1')])).state, 'answered')
  assert.equal(st((v) => (v.asks = [answered('ask1')]), { askWait: { [`${R}#id:ask1`]: { root: R, at: NOW, q: '続き', ask: 'ask1', answers: 1 } } }).state, 'wait')
  const pressed = (v: CockpitView) => {
    v.asks = [answered('ask1')]
    v.log.ops.push(decide(9, 'ask1', { choice: 'A' }))
  }
  assert.deepEqual(pick(st(pressed)), { state: 'reflecting', undelivered: false })
  assert.deepEqual(pick(st((v) => (pressed(v), (v.askSent = [9])))), { state: 'reflecting', undelivered: false })
  assert.deepEqual(pick(st((v) => (pressed(v), (v.askSent = [])))), { state: 'reflecting', undelivered: true })
  const acked = (v: CockpitView) => {
    v.asks = [answered('ask1', { answers: 2, entries: [q('09:10', '入口は？'), a('09:11', '2 案'), q('09:12', '案 A で。'), a('09:13', '返しを書いた')], decide: { at: '09:13', head: '返しを書いた', n: 2 }, returns: [{ return_id: 'ask1-1', op: 9 }] })]
    v.log.ops.push(decide(9, 'ask1', { choice: 'A' }))
  }
  assert.equal(st(acked).state, 'reflecting')
  assert.equal(st((v) => (acked(v), (v.cockpit!.asks = [{ id: 'ask1', held_returns: ['ask1-1'] }]))).state, 'reflecting')
  assert.equal(st((v) => (acked(v), (v.cockpit!.asks = [{ id: 'ask1', from_returns: ['ask1-1'] }]))).state, 'done')
  assert.equal(st((v) => (pressed(v), (v.cockpit!.applied_ops = [9]))).state, 'done')
  assert.equal(st((v) => {
    v.asks = [answered('ask1', { returns: [{ return_id: 'ask1-1' }] })]
    v.log.ops.push(decide(9, 'ask1'))
  }).state, 'reflecting')
  assert.equal(st((v) => {
    v.asks = [answered('ask1', { answers: 2, entries: [q('09:10', '入口は？'), a('09:11', '2 案'), q('09:20', '図は？'), a('09:21', '1 枚')], decide: { at: '09:21', head: '1 枚', n: 2 } })]
    v.log.ops.push(decide(9, 'ask1', { choice: 'A' }))
    v.cockpit!.applied_ops = [9]
  }).state, 'answered')
})
const pick = (s: { state: string; undelivered: boolean }) => ({ state: s.state, undelivered: s.undelivered })

test('やりとりの一覧: 答えあり → 答え待ち → 反映待ち → 反映済み、同じ状態の中は新しい順。既定は済んでいないものだけ', () => {
  const m = aoba((v) => {
    v.asks = [
      answered('ask1', { updated: at(30) }),
      answered('ask2', { updated: at(5) }),
      ask('ask3', { entries: [q('09:30', '答え待ち')], first: '答え待ち', updated: at(1) }),
      answered('ask4', { updated: at(2) }),
      answered('ask5', { updated: at(3), returns: [{ return_id: 'ask5-1', op: 15 }] })
    ]
    v.log.ops.push(decide(14, 'ask4', { at: at(2), answer: { at: '09:11', head: 'ask4 の答え', n: 1 } }), decide(15, 'ask5', { at: at(40), answer: { at: '09:11', head: 'ask5 の答え', n: 1 } }))
    v.cockpit!.asks = [{ id: 'ask5', from_returns: ['ask5-1'] }]
  })
  const b = m.boards[0]!
  const ui = newUi()
  assert.deepEqual(askRows(b, ui).map((r) => [r.id, r.state]), [['ask2', 'answered'], ['ask1', 'answered'], ['ask3', 'wait'], ['ask4', 'reflecting'], ['ask5', 'done']])
  assert.deepEqual(shownAskRows(b, ui).map((r) => r.id), ['ask2', 'ask1', 'ask3', 'ask4'])
  assert.deepEqual(shownAskRows(b, { ...ui, askAll: true }).map((r) => r.id), ['ask2', 'ask1', 'ask3', 'ask4', 'ask5'])
  assert.equal(askRows(b, ui).find((r) => r.id === 'ask4')!.at, Date.parse(at(2)))

  const h = page(m, { tab: 'asks' })
  assert.match(h, /data-tab="asks" aria-selected="true">やりとり<span class="n">2<\/span>/, 'タブの数字は答えありの件数')
  assert.match(text(h), /済んでいない すべて 答えあり/, '中央の見出しは出さず、絞り込みに数を付けない（タブの数と並んで何の数か分からないため）')
  assert.match(h, /data-askall="0" aria-pressed="true"/)
  assert.doesNotMatch(h, /data-thread="ask5"/)
  assert.match(page(m, { tab: 'asks', askAll: true }), /data-thread="ask5" data-settled="1"/)
  assert.match(text(h), /答えあり ask2 の質問 案件全体 09:55 答えあり ask1 の質問 案件全体 09:30 答え待ち 答え待ち 案件全体 09:59 反映待ち ask4 の質問 案件全体 09:58/)
  const none = aoba((v) => (v.asks = [ask('ask1', { entries: [q('09:30', 'x')] })]))
  assert.equal(answeredCount(none.boards[0]!, newUi()), 0)
  assert.match(page(none, {}), /data-tab="asks" aria-selected="false">やりとり<\/button>/)
})

test('やりとりの会話: 何についての質問か（押すと詳細へ）・写しの会話を開く・時刻順の質問と答え・A で返す・入力欄 1 つ', () => {
  const choices = [{ key: 'A', title: '地図のタイルを 1 日分ためる', pick: true as const }, { key: 'B', title: '見積もりを出す' }]
  const m = aoba((v) => {
    v.asks = [answered('ask1', { task: 't1', choices, entries: [q('09:10', '地図は？'), a('09:11', '窓口の会話 09:05 時点\n2 案あります。')], decide: { at: '09:11', head: '2 案あります。', n: 1 } })]
  })
  const h = page(m, { tab: 'asks', thread: 'ask1' })
  const side = h.slice(h.indexOf('<aside class="wside" aria-label="会話">'))
  assert.match(side, /<button type="button" class="alk" data-tab="whole" data-task="t1">タスク「一覧の並べ替えと絞り込み」<\/button><button class="nxl" type="button" data-ask="tab" data-id="ask1">写しの会話を開く<\/button>/)
  assert.match(text(side), /答えあり 質問 09:10 地図は？ 答え 09:11（窓口の 09:05 までの会話から） 2 案あります。 案を選んで窓口に返す A で返す 地図のタイルを 1 日分ためる おすすめ B で返す 見積もりを出す/)
  assert.match(side, /data-ask="decide" data-id="ask1" data-at="09:11" data-head="2 案あります。" data-n="1" data-choice="A">A で返す/)
  assert.match(side, /data-ask="send" data-scope="\/ws\/aoba#id:ask1" disabled>続けて聞く<\/button><button class="btn" type="button" data-ask="reply" data-scope="\/ws\/aoba#id:ask1" data-id="ask1" data-at="09:11" data-head="2 案あります。" data-n="1" disabled>書いたことを窓口に返す/)
  assert.match(page(m, { tab: 'asks', thread: 'ask1', askDraft: { [`${R}#id:ask1`]: 'A で、ただし来週から' } }), /data-ask="reply"[^>]*data-n="1">書いたことを窓口に返す/, '書いたら押せる')
  assert.match(text(h.slice(0, h.indexOf('<aside'))), /答えあり ask1 の質問 タスク「一覧の並べ替えと絞り込み」・選べる案 2 つ/)

  m.boards[0]!.v.log.ops.push(decide(9, 'ask1', { choice: 'A', answer: { at: '09:11', head: '2 案あります。', n: 1 } }))
  m.boards[0]!.v.askSent = [9]
  const after = page(m, { tab: 'asks', thread: 'ask1' })
  assert.doesNotMatch(after, /data-choice="A"/)
  assert.match(text(after), /A で返しました 地図のタイルを 1 日分ためる/)
  assert.match(text(after), /2 案あります。 返した 09:12 写しに届けました・返し待ち 案 A（地図のタイルを 1 日分ためる）/)
  m.boards[0]!.v.asks![0] = answered('ask1', { task: 't1', answers: 2, entries: [q('09:10', '地図は？'), a('09:11', '2 案あります。'), q('09:12', '案 A で。'), a('09:13', '返しを書きました')], decide: { at: '09:13', head: '返しを書きました', n: 2 }, returns: [{ return_id: 'ask1-1', op: 9, decisions: [{ text: '地図はタイルをためる' }] }] })
  m.boards[0]!.v.cockpit!.asks = [{ id: 'ask1', from_returns: ['ask1-1'], notify: [{ return_id: 'ask1-1', task: 't1' }] }]
  const back = text(page(m, { tab: 'asks', thread: 'ask1', askAll: true }))
  // 上の状態（反映済み）と同じ札は重ねず、返しが届いた言葉への写しの答え（決まったことと同じ文）は出さない。
  assert.match(back, /2 案あります。 返した 09:12 担当へ未通知 案 A 地図はタイルをためる 続けて聞く/)
  assert.doesNotMatch(back, /質問 09:12 案 A で。|答え 09:13|窓口が反映済み/)
  // 写しの答えに決まったこと以外の話があれば、答えを残す（Codex 重大 3）。
  m.boards[0]!.v.asks![0]!.entries[3] = a('09:13', '地図はタイルをためます。既存データの移行日は未定です。')
  assert.match(text(page(m, { tab: 'asks', thread: 'ask1', askAll: true })), /答え 09:13（[^）]*） 地図はタイルをためます。既存データの移行日は未定です。/)
  // 前の答えの案 A と今の答えの案 A が別のものでも、返した案の題は返したときの答えから引く（Codex 重大 2）。
  m.boards[0]!.v.asks![0] = answered('ask1', { task: 't1', answers: 2, choices: [{ key: 'A', title: '登録順のまま' }], entries: [q('09:10', '並びは？'), a('09:11', '2 案あります。\n\n【選べる案】\n- A: 配送日の降順\n- B: 登録順のまま'), q('09:12', '案 A で。'), a('09:13', '別の案です。\n\n【選べる案】\n- A: 登録順のまま\n- B: 番号順')], decide: { at: '09:13', head: '別の案です。', n: 2 } })
  const twice = text(page(m, { tab: 'asks', thread: 'ask1', askAll: true }))
  assert.match(twice, /返した 09:12 [^答]*案 A（配送日の降順）/)
  assert.doesNotMatch(twice, /案 A（登録順のまま）/)
})

test('やりとりの会話: 古い op・写しが自分で書いた返し・保留・会話が先に進んで届いていない op を語で出す', () => {
  const m = aoba((v) => {
    v.cockpit!.asks = [{ id: 'ask1', from_returns: ['ask1-1'], held_returns: ['ask1-2'] }]
    v.asks = [answered('ask1', { returns: [{ return_id: 'ask1-1', decisions: [{ text: '入口は 1 つ' }] }, { return_id: 'ask1-2', decisions: [{ text: '図は描き足さない' }] }, { return_id: 'ask1-3', op: 9 }] })]
    v.log.ops.push(decide(9, 'ask1'))
  })
  const t = text(page(m, { tab: 'asks', thread: 'ask1' }))
  assert.match(t, /返した 09:12 窓口に返したこと 窓口が反映済み/)
  assert.doesNotMatch(t, /窓口の反映待ち/, '上の状態「反映待ち」と重なる札は出さない')
  assert.match(t, /窓口に返したこと 窓口が反映済み 入口は 1 つ 窓口に返したこと 窓口が保留 図は描き足さない/)
  const moved = aoba((v) => {
    v.asks = [answered('ask1', { answers: 2, entries: [q('09:10', '入口は？'), a('09:11', '2 案'), q('09:20', '別の話'), a('09:21', '別の答え')], decide: { at: '09:21', head: '別の答え', n: 2 } })]
    v.log.ops.push(decide(9, 'ask1', { choice: 'B' }))
    v.askSent = []
  })
  const h = page(moved, { tab: 'asks', thread: 'ask1' })
  assert.match(text(h), /返した 09:12 写しに届いていない・会話が先に進んだので窓口が控えから拾います 案 B/)
  assert.match(h, /<span class="crumb miss">写しに届いていない<\/span>/)
})

test('やりとりの会話: 答えを待つあいだは決めさせず続けても聞かせない。送った直後は秒で出し、3 分で止め、立てられなければ理由を出す', () => {
  const m = aoba((v) => {
    v.asks = [ask('ask1', { answers: 1, entries: [q('09:10', '入口は？'), a('09:11', '1 つ'), q('09:20', '図は？')], first: '入口は？' }), ask('ask2')]
  })
  const h = page(m, { tab: 'asks', thread: 'ask1' })
  assert.doesNotMatch(h, /data-ask="decide"|data-askdraft="\/ws\/aoba#id:ask1"/)
  assert.doesNotMatch(text(h), /まだ答えが届いていません/, '上の「答え待ち」で分かる')
  assert.doesNotMatch(h, /data-thread="ask2"/, '節も返しも無い控えは出さない')
  const key = `${R}#stream:s2`
  const ui = { ...newUi(), tab: 'asks' as const }
  askStarted(ui, key, { root: R, at: NOW - 4000, q: '構成図に入口を描く？', answers: 0 })
  assert.equal(ui.thread, waitId(key))
  const w = page(m, ui)
  assert.match(w, new RegExp(`data-thread="wait:${key}" aria-current="true">\\s*<span class="ast s-wait">答え待ち</span>`))
  assert.match(text(w), /仕事「AWS 構成案」 答え待ち 送った質問 構成図に入口を描く？ 窓口の写しを立てています（4 秒）/)
  askOpened(ui, key, { opened: true, ask: 'ask2' })
  assert.equal(ui.thread, 'ask2', '質問 id が決まったら、その行を選んだまま付け替える')
  assert.match(text(page(m, ui)), /答えを待っています（4 秒） 1 問目は 10 秒ほどかかります/)
  assert.match(text(page(m, { ...ui, askWait: { [key]: { ...ui.askWait[key]!, at: NOW - 200_000 } } })), /3 分たっても答えが届いていません/)
  const bad = { ...newUi(), tab: 'asks' as const }
  askStarted(bad, `${R}#whole`, { root: R, at: NOW, q: '入口は？', answers: 0 })
  askOpened(bad, `${R}#whole`, { opened: false, reason: '窓口の会話が分かりません' })
  const f = page(m, bad)
  assert.doesNotMatch(f, /data-thread="wait:/)
  assert.match(text(f), /窓口の写しを立てられませんでした 窓口の会話が分かりません 閉じる 案件全体への質問 入口は？/)
})

test('どこから聞いても、送ったらやりとりのタブでその会話を選ぶ（質問のタブは前に出さない。R172）', () => {
  for (const scope of ['whole', 'card:d21', 'task:t1', 'stream:s2']) {
    const ui = { ...newUi(), tab: 'whole' as const }
    askStarted(ui, `${R}#${scope}`, { root: R, at: NOW, q: 'x', answers: 0 })
    assert.equal(ui.tab, 'asks')
    assert.equal(ui.thread, `wait:${R}#${scope}`)
  }
  const ui = { ...newUi(), tab: 'asks' as const, thread: 'ask1' }
  askStarted(ui, `${R}#id:ask1`, { root: R, at: NOW, q: '続き', ask: 'ask1', answers: 1 })
  assert.equal(ui.thread, 'ask1')
  assert.deepEqual(parseAskKey(askKey(R, { kind: 'stream', id: 's2' })), { root: R, scope: { kind: 'stream', id: 's2' } })
})

test('カード・タスクの詳細には会話を出さず、「質問する」と結んだやりとりの行だけを置く（R221）', () => {
  const m = aoba((v) => {
    v.asks = [answered('ask1', { card: 'd21', first: 'カードの質問', entries: [q('09:10', 'カードの質問'), a('09:11', 'カードの答えの本文')] }), answered('ask2', { task: 't1', first: 'タスクの質問', entries: [q('09:10', 'タスクの質問'), a('09:11', 'タスクの答えの本文')] }), answered('ask3', { first: '全体の質問' })]
  })
  const card = page(m, { sel: `${R}#d21` })
  const side = card.slice(card.indexOf('<aside'))
  assert.match(text(side), /このカードのやりとり 1 件 答えあり カードの質問/)
  assert.match(side, /<button type="button" class="arow" data-thread="ask1" aria-current="false">/)
  assert.doesNotMatch(text(side), /カードの答えの本文|タスクの質問|全体の質問/)
  assert.match(side, /data-ask="open" data-scope="\/ws\/aoba#card:d21">このカードについて質問する</)
  assert.doesNotMatch(side, /data-askdraft/)
  assert.match(page(m, { sel: `${R}#d21`, open: { [`aski:${R}#card:d21`]: true } }), /<textarea id="ask-card:d21" data-askdraft="\/ws\/aoba#card:d21"/)
  const task = page(m, { tab: 'whole', task: 't1' })
  const tside = task.slice(task.indexOf('<aside'))
  assert.match(text(tside), /このタスクのやりとり 1 件 答えあり タスクの質問/)
  assert.doesNotMatch(text(tside), /タスクの答えの本文/)
  assert.match(tside, /data-ask="open" data-scope="\/ws\/aoba#task:t1">このタスクについて質問する</)
  assert.doesNotMatch(task, /data-wside|案件への質問/)
})

test('全体で仕事を押すと、右に仕事の詳細（題・形・担当の名前）と、この仕事のやりとりと「質問する」を出す。概要と状況は中央の箱と重ねない（R220）', () => {
  const m = aoba((v) => {
    v.cockpit!.streams.find((s) => s.id === 's2')!.summary = 'AWS の構成図と説明の本文を作る'
    v.asks = [ask('ask1', { stream: 's2', first: '入口を描くか相談したい', entries: [q('09:10', '入口を描くか相談したい')], updated: at(10) })]
  })
  const h = page(m, { tab: 'whole', stream: 's2' })
  assert.match(h, /<button type="button" class="t" data-stream="s2" data-toggle="s:s2" aria-expanded="true" aria-current="true">/)
  const side = h.slice(h.indexOf('<aside class="wside" aria-label="仕事の詳細">'))
  assert.doesNotMatch(text(side), /概要|状況|AWS の構成図と説明の本文を作る/)
  assert.match(text(side), /この仕事のやりとり 1 件 答え待ち 入口を描くか相談したい 09:50/)
  assert.match(side, /data-ask="open" data-scope="\/ws\/aoba#stream:s2">この仕事について質問する</)
  assert.doesNotMatch(side, /data-askdraft/)
  assert.match(side, /<div class="dbtn"><div class="acts"><button class="btn talk" type="button" data-talkstream="s2">/)
  const t = page(m, { tab: 'asks', thread: 'ask1' })
  assert.match(t, /<button type="button" class="alk" data-tab="whole" data-stream="s2">仕事「AWS 構成案」<\/button>/)
})

test('判断の記録の当たり: 原文・番号・日時・種類をすぐ出し、「それでも窓口の写しに聞く」で質問に回す。欄は案件ごと', () => {
  const m = aoba()
  const h = page(m, { tab: 'asks', askHits: { [`${R}#whole`]: { q: '入口は？', hits: [{ id: 'R12', at: '2026-11-21T22:48:00+09:00', kind: 'decision', text: '入口は 1 つにする', quote: '1 つでいい' }] } } })
  assert.match(text(h), /判断の記録に当たりました（1 件） 質問はまだ送っていません R12 11\/21\(土\) 22:48・決定 入口は 1 つにする 1 つでいい それでも窓口の写しに聞く/)
  assert.match(h, /class="btn pri" type="button" data-ask="go" data-scope="\/ws\/aoba#whole"/)
  assert.match(h, /class="btn" type="button" data-ask="send" data-scope="\/ws\/aoba#whole"/)
  const other = page(m, { tab: 'asks', askDraft: { '/ws/other#whole': 'A の下書き' }, askHits: { '/ws/other#whole': { q: 'A', hits: [{ id: 'R1', text: 'A の判断' }] } }, askWait: { '/ws/other#whole': { root: '/ws/other', at: NOW, q: 'A の質問', answers: 0 } } })
  assert.doesNotMatch(text(other), /A の下書き|A の判断|A の質問/)
  assert.match(other, /data-ask="send" data-scope="\/ws\/aoba#whole" disabled>聞く/)
  assert.match(page(m, { tab: 'asks', askDraft: { [`${R}#whole`]: '入口は？' } }), /data-ask="send" data-scope="\/ws\/aoba#whole">聞く/)
})

test('質問の答え（R167）: 時点の行を見出しに移し、窓口への返しの塊を外し、Markdown で描く。生の HTML は文字のまま', () => {
  assert.deepEqual(answerParts('窓口の会話 22:40 時点（それより後に決まったことは知らない）\n**1 つ**にする\n\n【窓口への返し】\n```json\n{}\n```'), { at: '22:40', body: '**1 つ**にする' })
  assert.deepEqual(answerParts('時点の行が無い答え'), { body: '時点の行が無い答え' })
  assert.equal(answerHead('窓口の会話 22:40 時点\n**1 つ**にする'), '1 つにする')
  const answer = '窓口の会話 09:05 時点\n## 結論\n入口は **1 つ** にする。\n| 案 | 手間 |\n|---|---|\n| A | 小さい |\n- 一覧を直す\n<script>alert(1)</script>'
  const m = aoba((v) => {
    v.asks = [answered('ask1', { entries: [q('09:10', '入口は？'), a('09:11', answer)] })]
  })
  const h = page(m, { tab: 'asks', thread: 'ask1' })
  assert.match(h, /<div class="rich md"><h5 class="mdh">結論<\/h5><p>入口は <strong>1 つ<\/strong> にする。<\/p><div class="mdtbl"><table>/)
  assert.match(h, /<ul><li>一覧を直す<\/li><\/ul><p>&#60;script&#62;alert\(1\)&#60;\/script&#62;<\/p>/)
  assert.doesNotMatch(h, /<script>alert/)
  assert.match(text(page(aoba((v) => (v.asks = [answered('ask1', { omitted: 4 })])), { tab: 'asks', thread: 'ask1' })), /これより前の 4 節は写しの会話で読めます/)
})
