import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { parseCockpit, STAGES, stageOf, taskSig, type DraftFormat } from './model.ts'
import type { ClipResult, CockpitView } from './protocol.ts'
import { copyDraft, copyMessage, copyTarget } from './controller.ts'
import { boardsOf, dropRulings, newUi, render, rowId, SENT_LABEL, tighten, type Model, type Ui } from './view.ts'
import { CSS } from './style.ts'
import { renderWindow, rruleText, stagesHtml, taskOrder, todoOrder } from './window-view.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

function aoba(edit: (v: CockpitView) => void = () => {}): Model {
  const w = sample(NOW)[0]!
  const v: CockpitView = { state: 'ok', root: '/ws/aoba', cockpit: parseCockpit(JSON.stringify(w.cockpit)), log: structuredClone(w.log), archive: [], figures: {}, errors: [], workers: [], notifiedOp: 0 }
  edit(v)
  return { boards: boardsOf([v], NOW), focused: '/ws/aoba', unseen: [], errors: [] }
}
const page = (m: Model, over: Partial<Ui> = {}) => {
  const ui = { ...newUi(), ...over }
  ui.sel ??= todoOrder(m.boards[0])[0]
  return renderWindow(m, ui, NOW, (s) => s)
}

test('要対応: 仕事ごとにまとめ、先頭の詳細を右に開く。届いたは出さず、相談は見出しで別に数え、「件数外」の札は付けない（初見 12）', () => {
  const m = aoba()
  const h = page(m)
  const t = text(h)
  assert.match(h, /data-tab="todo" aria-selected="true">要対応<span class="n">3<\/span>/)
  assert.ok(!/data-sel="\/ws\/aoba#i3"/.test(h), '届いたは要対応に出さない')
  assert.doesNotMatch(h, /件数外/)
  assert.match(h, /class="wdet k-/)
  assert.match(t, /配車画面の改修|AWS 構成案/)
})

test('タスクの詳細の worker の「端末を開く」は、開いた知らせで誰のものかを言えるよう worker の題を持つ', () => {
  const m = aoba((v) => {
    v.workers = [{ terminalId: 'term_w', title: '作業｜一覧の改修', agent: 'claude', state: 'working', since: NOW, task: 't1', where: 'テストを直している' }]
  })
  assert.match(page(m, { tab: 'whole', task: 't1' }), /<div class="wk2">[\s\S]*?data-term="term_w" data-wt="" data-who="作業｜一覧の改修の worker">端末を開く<\/button>/)
})

test('窓の余白（padding・margin・gap）は 4・8・12・16・24px の刻みから選び、32px 以上は 4 の倍数にする（ui.md）', () => {
  const off: string[] = []
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    // 質問の欄（案件への質問・右の欄の切り替え）は別の作業（t138）が直している最中なので、ここでは見ない。
    if (!/\.ck\.win/.test(sel) || /\.(ask\w*|aa|aq|hits|hl|ht|wsw)\b/.test(sel)) continue
    for (const p of m[2]!.matchAll(/(?<![-\w])((?:padding|margin)(?:-[a-z-]+)?|gap|row-gap|column-gap)\s*:\s*([^;}]+)/g))
      for (const v of p[2]!.matchAll(/(\d+)px/g)) {
        const n = Number(v[1])
        if (n && ![4, 8, 12, 16, 24].includes(n) && !(n >= 32 && n % 4 === 0)) off.push(`${sel.split('\n').pop()} ${p[1]}:${n}px`)
      }
  }
  assert.deepEqual(off, [])
})

test('要対応の行の題は「…」で 1 行に切らず、2 行まで折り返して 3 行目から切る（ui.md。利用者役の初見で題が切れて読めなかった）', () => {
  const h = page(aoba())
  assert.match(h, /class="cardrow[^"]*"[^>]*>[\s\S]*?<span class="tl"><span class="ti">/)
  const rule = /\.ck\.win \.cardrow \.tl \.ti \{([^}]*)\}/.exec(CSS)![1]!
  assert.doesNotMatch(rule, /nowrap|ellipsis/)
  assert.match(rule, /-webkit-line-clamp:2/)
  // 切るのは補助の情報（2 行目の居場所）から。
  assert.match(/\.ck\.win \.cardrow \.crumb \{([^}]*)\}/.exec(CSS)![1]!, /ellipsis/)
})

test('見てほしい点の「1 …」の番号は一覧の番号にし（二重にしない）、続かない数字の文は一覧の下に添える', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.find((x) => x.id === 'r5')!.look_for = ['1 一覧の幅', '2「担当と話す」の位置', '6 点ともおすすめなら「これでよい」']
  })
  const h = page(m, { sel: '/ws/aoba#r5' })
  assert.match(h, /<li value="1">一覧の幅<\/li><li value="2">「担当と話す」の位置<\/li><\/ol><p class="mut">6 点ともおすすめなら「これでよい」<\/p>/)
})

test('全体の仕事の行（追加 42）: 題は切らずに 1 行目に出し、長い待ちの文は 3 行目の状況に寄せる（題が幅 0 になって消えた）。担当は閉じていない担当を全部出す', () => {
  const m = aoba((v) => {
    const s = v.cockpit!.streams[0]!
    v.cockpit!.tasks = v.cockpit!.tasks.map((t) => (t.stream === s.id ? { ...t, state: 'open' as const, worker: undefined, wait: { kind: 'event' as const, what: 'スマホで、カードの詳細に要る情報が出ているかを使いながら確かめる（r67 の3）' } } : t))
    v.cockpit!.cards = v.cockpit!.cards.filter((c) => c.stream !== s.id)
    v.cockpit!.owners = [{ id: 'o1', title: s.title, stream: s.id, agent: 'claude', state: 'open' }, { id: 'o3', title: 'Botの組み直し', stream: s.id, agent: 'claude', state: 'open' }, { id: 'o5', title: '任せる｜決まりの一本化', stream: s.id, agent: 'claude', state: 'open' }, { id: 'o4', title: '済んだ担当', stream: s.id, agent: 'claude', state: 'done' }]
  })
  const s = m.boards[0]!.v.cockpit!.streams[0]!
  const h = page(m, { tab: 'whole' })
  const box = h.slice(h.indexOf(`data-toggle="s:${s.id}"`))
  const head = box.slice(0, box.indexOf('</div>'))
  assert.match(head, new RegExp(`<span class="nm">${s.title}</span></button>`))
  assert.match(text(head), /状況 スマホで、カードの詳細に要る情報が出ているかを使いながら確かめる（r67 の3）を待つ/)
  // 協議の相手（ownerOf の 1 人目）が仕事と同じ名前でも、担当が 2 人以上なら全部出す（Codex）。
  assert.match(text(head), new RegExp(`担当: ${s.title}・Botの組み直し・任せる｜決まりの一本化`))
  assert.doesNotMatch(head, /済んだ担当/)
  // 題は「…」で切らない。
  const rule = /\.ck\.win \.st \.t \.nm \{([^}]*)\}/.exec(CSS)![1]!
  assert.doesNotMatch(rule, /nowrap|ellipsis/)
})

test('全体: 一緒に作る → 任せる → 形の無い仕事（進行中の仕事） → 見張る の順に置き（仕事を先に）、見張るに届いた連絡を並べる。右に未対応の一覧を出さない（R91）。区分の見出しは形と件数だけ（説明は出さない）', () => {
  const m = aoba((v) => {
    const s = v.cockpit!.streams
    s[0]!.form = 'delegate'
    s[1]!.form = 'cowork'
    s[2]!.form = 'watch'
    v.cockpit!.requests = [{ id: 'r1', at: '2026-11-21T09:00:00+09:00', title: '配車画面を直す', tasks: ['t1'], legacy: true }]
  })
  const t = text(page(m, { tab: 'whole' }))
  const order = ['一緒に作る 1 件', '任せる 1 件', '進行中の仕事 1 件', '見張る 1 件'].map((x) => t.indexOf(x))
  assert.ok(order.every((n) => n >= 0), t)
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.match(t, /届いた連絡 1 件/)
  assert.doesNotMatch(t, /件数外/, '意味の伝わらない語は出さない（初見 12）')
  assert.doesNotMatch(t, /未完了の依頼/)
  assert.doesNotMatch(t, /話しながら進めているもの|任せている作業の進み具合|見回りと届いたもの/)
})

test('全体の仕事の行（追加 38・R188・R204）: 題・概要・状況。状況は状態の語のあとに窓口の書いた status を切らずに出し、next は出さない。タスクの行と詳細は概要（goal）と、事実から決めた状況', () => {
  const status = '一覧の並べ替えは stg に出した。田中さんが画面を見て返事をくれるのを待っている。返事が来たら本番に出す日を決める。'
  const m = aoba((v) => {
    v.cockpit!.streams[0]!.summary = '配車画面の一覧を探しやすくする'
    v.cockpit!.streams[0]!.status = status
    const t1 = v.cockpit!.tasks.find((x) => x.id === 't1')!
    t1.goal = '配車の一覧で探す手間を減らす'
    v.workers = [{ terminalId: 'term_w', title: '一覧の改修（worker）', agent: 'claude', state: 'working', since: NOW, task: 't1', where: 'テストを直している' }]
  })
  const h = page(m, { tab: 'whole', task: 't1' })
  const c = m.boards[0]!.v.cockpit!
  const s0 = c.streams[0]!
  const box = (id: string) => h.slice(h.indexOf(`data-toggle="s:${id}"`), h.indexOf('</div>', h.indexOf(`data-toggle="s:${id}"`)))
  // 状態の語（作業中・worker の今）を先に、状況の文は次の行に全文（切らない）。
  assert.match(box(s0.id), new RegExp(`<span class="pst [^"]+">[^<]+</span>(<span>・[^<]+</span>)?<span class="said">${status}</span>`))
  assert.match(box(s0.id), /class="sx sum" title="配車画面の一覧を探しやすくする">/)
  // next は一覧に出さない（帳簿の next は作業の手順で、初見で読めない羅列になりうる。R187）。
  const next = c.tasks.find((x) => x.stream === s0.id && x.next)?.next
  if (next) assert.ok(!text(box(s0.id)).includes(next))
  assert.doesNotMatch(text(box(s0.id)), /次は/)
  // status の無い仕事は状態の語だけ。
  const other = c.streams.find((x) => !x.status && !x.summary)!
  assert.doesNotMatch(text(box(other.id)), /概要/)
  assert.doesNotMatch(box(other.id), /class="said"/)
  // タスクの行: 題・概要（goal、2 行で畳み全文は title）・状況（事実から決めた 1 行。R204）。詳細には状況と、別に次にやること。
  const label = m.boards[0]!.d.tasks.get('t1')!.label
  assert.ok(label)
  const row = h.slice(h.indexOf('data-task="t1"'), h.indexOf('</button>', h.indexOf('data-task="t1"')))
  assert.match(row, new RegExp(`<span class="nx gl" title="配車の一覧で探す手間を減らす">配車の一覧で探す手間を減らす</span><span class="nx">${label}</span>`))
  const side = text(h.slice(h.indexOf('aria-label="タスクの詳細"')))
  assert.ok(side.includes(`状況 ${label}`), side)
  assert.ok(side.includes('次にやること レビューの指摘を直して stg に出す'), side)
  // タスクの行に next は出さない。
  const t2 = c.tasks.find((x) => x.id !== 't1' && x.next && x.state !== 'ok')
  if (t2) {
    const open = page(m, { tab: 'whole', open: { [`s:${t2.stream}`]: true } })
    const r2 = open.slice(open.indexOf(`data-task="${t2.id}"`), open.indexOf('</button>', open.indexOf(`data-task="${t2.id}"`)))
    assert.ok(!text(r2).includes(t2.next!), r2)
  }
})

test('全体: タスクを押すと右に詳細（工程・状態・goal・next・done・worker・結ばれたカード・依頼の原文と済の条件・出した指示）を出し、その箱を開く', () => {
  const m = aoba((v) => {
    const t1 = v.cockpit!.tasks.find((x) => x.id === 't1')!
    t1.goal = '配車の一覧で探す手間を減らす'
    t1.done = ['並べ替えを入れた']
    v.cockpit!.cards.find((x) => x.id === 'r5')!.tasks = ['t1']
    v.cockpit!.requests = [{ id: 'q7', at: '2026-11-21T09:00:00+09:00', title: '一覧を直す', tasks: ['t1'], kind: 'work', utterances: [{ id: 'u1', quote: '一覧で探しにくい' }], done_when: ['並べ替えができる', '絞り込みができる'] }]
    v.workers = [{ terminalId: 'term_w', title: '一覧の改修（worker）', agent: 'claude', state: 'working', since: NOW, task: 't1', where: 'テストを直している' }]
    v.log.ops.push({ op_id: 2, at: '2026-11-21T09:40:00+09:00', item_id: 'r5', item_rev: 1, type: 'talk', text: '幅を 1280 でも崩れないように' })
  })
  const h = page(m, { tab: 'whole', task: 't1' })
  // j・k と何も選んでいないときの順は、箱を全部開いたときの画面の上からの順と同じ。
  const all = page(m, { tab: 'whole', open: { 's:s1': true, 's:s2': true, 's:s3': true } })
  assert.deepEqual(taskOrder(m.boards[0]), [...all.matchAll(/data-task="(\w+)"/g)].map((x) => x[1]))
  const side = h.slice(h.indexOf('aria-label="タスクの詳細"'))
  const t = text(side)
  assert.match(h, /class="task"><button type="button" class="tsel" data-task="t1" aria-current="true"/)
  assert.match(h, /data-toggle="s:s1" aria-expanded="true"/)
  for (const x of ['作業中 工程 調査 ・ 決定 ・ 作成 ・ 確認 ・ 反映', '何のため 配車の一覧で探す手間を減らす', '済の条件 並べ替えができる 絞り込みができる', '次にやること レビューの指摘を直して stg に出す', '済んだこと 並べ替えを入れた', '一覧の改修（worker）', '今: テストを直している', '一覧で探しにくい'])
    assert.ok(t.includes(x), x)
  assert.match(side, /data-jump="\/ws\/aoba#r5"/)
  assert.match(side, /<span class="cb" role="img" aria-label="未"><\/span>並べ替えができる/)
  // 済んだ条件は「済 n 件」に畳み、まだの条件を先に見せる（追加 38）。
  m.boards[0]!.v.cockpit!.requests![0]!.evidence = [{ when: 1, kind: 'commit', ref: 'abc1234' }]
  const folded = page({ ...m, boards: boardsOf(m.boards.map((b) => b.v), NOW) }, { tab: 'whole', task: 't1' })
  const fs = folded.slice(folded.indexOf('済の条件'))
  // 開いた畳みは再描画のあとも開いたまま（data-fold で ui.open に残す。Codex）。
  assert.match(page({ ...m, boards: boardsOf(m.boards.map((b) => b.v), NOW) }, { tab: 'whole', task: 't1', open: { 'met:t1': true } }), /data-fold="met:t1" open>/)
  assert.match(fs, /^済の条件<\/span><div><ol class="dw"><li class=""><span class="cb" role="img" aria-label="未"><\/span>絞り込みができる<\/li><\/ol><details class="cont" data-fold="met:t1"><summary>済 1 件<\/summary><ol class="dw"><li class="ok">[^]*並べ替えができる/)
  // 番号は一覧の行に出さず、詳細の下に小さく置く（初見 2）。
  assert.doesNotMatch(all, /class="id"/)
  assert.match(side, /<p class="rid">番号<code>t1<\/code><\/p>/)
  assert.match(t, /出した指示 .*r5 修正を依頼 未反映 幅を 1280 でも崩れないように/)
  assert.doesNotMatch(h, /data-rq=/)
})

test('出した指示: カードの詳細に、本文と時刻を新しい順に出し、反映済み・未反映を分ける。取り消した操作は出さない', () => {
  const m = aoba((v) => {
    v.log.ops.push(
      { op_id: 2, at: '2026-11-21T09:40:00+09:00', item_id: 'd21', item_rev: 1, type: 'talk' },
      { op_id: 3, at: '2026-11-21T09:50:00+09:00', item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'draw' },
      { op_id: 4, at: '2026-11-21T09:50:05+09:00', item_id: 'd21', item_rev: 1, type: 'undo', undo_of: 3 },
      { op_id: 5, at: '2026-11-21T09:55:00+09:00', item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'other', text: '社内向けは別の図にする' })
  })
  const closed = text(page(m, { tab: 'done', doneSel: '/ws/aoba#d21' }))
  assert.match(closed, /出した指示 11\/21\(土\) 09:55 別の回答 未反映 社内向けは別の図にする 11\/21\(土\) 09:40 協議を開始 未反映/)
  assert.doesNotMatch(closed, /図に社内向けの入口を描き足す 未反映/)
  // 窓口が反映した操作（applied_ops）は反映済み。
  assert.match(text(page(aoba(), { tab: 'done', doneSel: '/ws/aoba#d19' })), /出した指示 .* 決定: 議題だけテキストで送る 反映済み/)
})

test('相談: カードの詳細に相談のメモへのリンクと、新しい返しから決まったことを 3 件まで出し、窓口が帳簿に入れたか・保留かを札で分ける', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.find((x) => x.id === 'd21')!.from_returns = ['d21-1']
    v.cockpit!.cards.find((x) => x.id === 'd21')!.held_returns = ['d21-3']
    v.consults = [
      { card: 'd21', path: '/ws/aoba/.orca/consult/d21.md', returnsPath: '/ws/aoba/.orca/consult/d21.returns.jsonl', returns: [
        { return_id: 'd21-1', decisions: [{ text: '入口は 1 つにする' }, { text: '古い決定' }] },
        { return_id: 'd21-2', choice: 'draw', decisions: [{ text: '社内向けは別の図にする' }] },
        { return_id: 'd21-3', decisions: [] }
      ] },
      { card: 'c4', path: '/ws/aoba/.orca/consult/c4.md', returnsPath: '/ws/aoba/.orca/consult/c4.returns.jsonl', returns: [] }
    ]
  })
  const d21 = page(m, { sel: '/ws/aoba#d21' })
  const label = m.boards[0]!.v.cockpit!.cards.find((x) => x.id === 'd21')!.options!.find((o) => o.id === 'draw')!.label
  assert.ok(text(d21).includes(`これまでに決まったこと 選んだ案: ${label} 未反映 社内向けは別の図にする 未反映 入口は 1 つにする 反映済み ファイル 相談のメモ`), text(d21))
  assert.doesNotMatch(text(d21), /古い決定/)
  assert.match(d21, /data-file="\/ws\/aoba\/\.orca\/consult\/d21\.md"/)
  const c4 = text(page(m, { sel: '/ws/aoba#c4' }))
  assert.match(c4, /相談のメモ/)
  assert.doesNotMatch(c4, /これまでに決まったこと/)
  assert.doesNotMatch(text(page(m, { sel: '/ws/aoba#r5' })), /相談のメモ/)
})

test('Codex 13-6: 表示の 14 日を過ぎた済んだカードも、タスクの詳細の出した指示から対応済みのタブで開ける', () => {
  const m = aoba((v) => {
    const d19 = v.cockpit!.cards.find((x) => x.id === 'd19')!
    d19.tasks = ['t1']
    d19.resolved_at = new Date(NOW - 20 * 86_400_000).toISOString()
  })
  assert.ok(!m.boards[0]!.d.closed.some((r) => r.card.id === 'd19'), '対応済みの一覧には出さない')
  const side = page(m, { tab: 'whole', task: 't1' })
  assert.match(side, /<button type="button" class="code" data-jump="\/ws\/aoba#d19">d19<\/button>/)
  const done = page(m, { tab: 'done', doneSel: '/ws/aoba#d19' })
  assert.match(text(done.slice(done.indexOf('aria-label="詳細"'))), /定例の資料は作らず、議題だけテキストで送る/)
})

test('対応済み: 確認の返答が無いまま閉じた見てに札を付け、詳細に返した答えと片付けた人を出す', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.push({ id: 'v9', rev: 1, kind: 'review', state: 'done', title: '窓口が閉じた見て', resolved_at: '2026-11-21T09:30:00+09:00', closed_without_review: true })
  })
  const h = page(m, { tab: 'done', doneSel: '/ws/aoba#v9' })
  assert.match(h, /data-dsel="\/ws\/aoba#v9"[\s\S]*?確認なしで閉じた/)
  assert.match(text(h), /担当が完了 11\/21\(土\) 09:30・確認の返答なし/)
})

test('窓口に届かなかった操作は、どの案件を開いていても上の帯に案件の名前と理由を出し、その案件に送り直せる（追加 44）', () => {
  const views = sample(NOW).map((w): CockpitView => ({ state: 'ok', root: `/ws/${w.dir}`, cockpit: parseCockpit(JSON.stringify(w.cockpit)), log: structuredClone(w.log), archive: [], figures: {}, errors: [], workers: [], notifiedOp: 0 }))
  const aobaRoot = views.find((v) => v.cockpit!.workspace.name.startsWith('青葉'))!.root!
  const harness = views.find((v) => v.cockpit!.workspace.name === '社内ハーネス')!
  harness.signal = { state: 'failed', reason: 'Run run_m が見つかりません' }
  const h = renderWindow({ boards: boardsOf(views, NOW), focused: aobaRoot, unseen: [], errors: [] }, newUi(), NOW, (s) => s)
  const errs = h.slice(h.indexOf('<div class="werrs"'), h.indexOf('</div></div>', h.indexOf('<div class="werrs"')))
  assert.match(text(errs), /社内ハーネス のメインに、押した操作が届いていません（Run run_m が見つかりません）。 もう一度送る/)
  assert.match(errs, new RegExp(`data-act="notify" data-root="${harness.root}"`))
  harness.signal = undefined
  assert.doesNotMatch(renderWindow({ boards: boardsOf(views, NOW), focused: aobaRoot, unseen: [], errors: [] }, newUi(), NOW, (s) => s), /class="werrs"/)
})

test('案件のサイドバー: 名前の順に並べ、私の番の件数は語つきで 0 件は出さず、選んだ案件を描く。Orca の前面は語で示し、合わせるボタンは前面と違うときだけ押せる（追加 34）', () => {
  const views = sample(NOW).map((w): CockpitView => ({ state: 'ok', root: `/ws/${w.dir}`, cockpit: parseCockpit(JSON.stringify(w.cockpit)), log: structuredClone(w.log), archive: [], figures: {}, errors: [], workers: [], notifiedOp: 0 }))
  const aobaRoot = views.find((v) => v.cockpit!.workspace.name.startsWith('青葉'))!.root!
  const harness = views.find((v) => v.cockpit!.workspace.name === '社内ハーネス')!.root!
  const m: Model = { boards: boardsOf(views, NOW), focused: aobaRoot, unseen: [], errors: [] }
  const h = renderWindow(m, newUi(), NOW, (s) => s)
  const side = h.slice(h.indexOf('<nav class="wcases"'), h.indexOf('</nav>'))
  const names = [...side.matchAll(/<span class="nm">([^<]+)<\/span>/g)].map((x) => x[1])
  assert.deepEqual(names, [...names].sort((a, b) => a!.localeCompare(b!, 'ja')))
  assert.match(side, new RegExp(`data-filter="${aobaRoot}" aria-current="true"><span class="nm">青葉物流 配車アプリ</span><span class="n">私の番 \\d+</span><span class="here">Orca で表示中</span>`))
  assert.doesNotMatch(side, /私の番 0/)
  assert.match(h, /data-orca="sync" disabled>Orca に合わせる/)
  const picked = renderWindow(m, { ...newUi(), filter: harness }, NOW, (s) => s)
  assert.match(picked, /<span class="pj">社内ハーネス<\/span>/)
  assert.match(picked, /data-orca="sync">Orca に合わせる/)
  // 開閉のボタンは 1 つ。開いても畳んでも上の帯の先頭の同じ要素で、変わるのは aria-expanded だけ（R179。morph が同じ要素のまま属性だけを書き換える）。
  const closed = renderWindow(m, { ...newUi(), sideOpen: false }, NOW, (s) => s)
  assert.doesNotMatch(closed, /class="wcases"/)
  const toggle = (x: string) => /<div class="wtop">(<button class="sidebtn"[^>]*>[^<]*<\/button>)<span class="pj">/.exec(x)?.[1]
  assert.equal(toggle(h), '<button class="sidebtn" type="button" data-side="toggle" aria-controls="wcases" aria-expanded="true">案件の一覧</button>')
  assert.equal(toggle(closed), toggle(h)!.replace('aria-expanded="true"', 'aria-expanded="false"'))
  assert.equal((h.match(/data-side="toggle"/g) ?? []).length, 1, '開いたときにサイドバーの中に別の畳むボタンを置かない')
  // サイドバーで角丸を使わない（選んだ行は端までの背景と左の線）。
  const css = CSS.slice(CSS.indexOf('.ck.win .wcases'), CSS.indexOf('.ck.win .sidebtn'))
  assert.doesNotMatch(css.replace('border-radius:0', ''), /border-radius/)
  // Orca の前面が操縦席の無いワークスペースなら、合わせる先が無いので押せない（Codex 重大 3）。
  const noCockpit = renderWindow({ ...m, focused: '/ws/elsewhere' }, { ...newUi(), filter: harness }, NOW, (s) => s)
  assert.match(noCockpit, /data-orca="sync" disabled>/)
  // 別の案件で押した「送信済み」の取り消しは、この案件を描いているあいだ出さない（Codex 重大 2）。
  const undos = [{ root: aobaRoot, opId: 7, itemId: 's1', rev: 1, label: '送信済みにしました', title: '議事録', to: '担当', until: NOW + 5000 }]
  assert.match(renderWindow(m, { ...newUi(), undos }, NOW, (s) => s), /data-act="undo" data-op="7"/)
  assert.doesNotMatch(renderWindow(m, { ...newUi(), undos, filter: harness }, NOW, (s) => s), /data-act="undo"/)
})

test('窓口の未処理: 30 分を過ぎた未仕分けの発言は 1 件ずつ並べず件数の 1 行にし、返しで反映された発言は数えない（追加 32）', () => {
  const said = (i: number) => ({ id: `u${i}`, at: new Date(NOW - (60 + i) * 60_000).toISOString(), prompt: `発言の本文 ${i}` })
  const m = aoba((v) => {
    v.cockpit!.intake = { through: 'u0' }
    v.utterances = Array.from({ length: 14 }, (_, i) => said(i))
    v.returned = ['u12', 'u13']
  })
  const h = page(m)
  assert.match(h, /<div class="wnotes" role="status"><b>窓口の未処理<\/b>発言の仕分け 12 件（30 分超過）<span class="by">窓口が対応します（操作は不要）<\/span><\/div>/)
  assert.doesNotMatch(h, /発言の本文/)
  assert.doesNotMatch(h, /帳簿の未記入/)
  assert.match(page(m, { tab: 'whole' }), /<b>窓口の未処理<\/b>発言の仕分け 12 件/)
})

test('欄の形の違いの知らせは 1 行に畳み、読めない・繋がらない知らせだけを赤の帯に出す', () => {
  const m = aoba((v) => {
    v.errors = ['cockpit.json のカード v1「x」の evidence の形が違うので、その欄を出さずに表示しています']
  })
  m.errors = ['常駐のプロセスに繋がりません']
  const h = page(m)
  assert.match(h, /<div class="werrs" role="alert"><div>常駐のプロセスに繋がりません<\/div><\/div>/)
  assert.match(h, /<div class="wnotes" role="status"><b>窓口の未処理<\/b>帳簿の形式不備 1 件<span class="by">窓口が対応します（操作は不要）<\/span><\/div>/)
  assert.doesNotMatch(h, /evidence/)
  const panel = render({ ...m, panel: true }, newUi(), NOW, (x) => x)
  assert.match(panel, /<div class="chores" role="status"><b>窓口の未処理<\/b>帳簿の形式不備 1 件<span class="by">窓口が対応します（操作は不要）<\/span><\/div>/)
  assert.doesNotMatch(panel, /evidence/)
  // 仕事の見出しには工程 n/5（5 段で固定）と今の段の名前を出し、凡例の帯は出さない（R82）。
  assert.match(h, /<span class="stg"><span class="stg-all"><span class="sd">調査<\/span><span class="sep">・<\/span><b class="sc">決定<\/b><span class="sep">・<\/span><span class="sn">作成<\/span>/)
  assert.doesNotMatch(h, /class="keyline"/)
})

test('Codex v3 1: 送る文面と手作業の場所・手順は表示でも空白を詰めない（コピーする値と画面を食い違わせない）', () => {
  const draft = tighten(page(aoba((v) => { v.cockpit!.cards.find((c) => c.id === 'd22')!.draft!.text = 'cd 資料 を 開く' }), { sel: '/ws/aoba#d22' }))
  assert.match(draft, /<div class="msg">cd 資料 を 開く<\/div>/)
  const manual = tighten(page(aoba((v) => {
    v.cockpit!.cards.find((c) => c.id === 'd22')!.manual = { where: '/tmp/資料 A', command: 'cd 資料', steps: ['Finder で 資料 A を開く'], check: '開けた 2 件を確かめる' }
  }), { sel: '/ws/aoba#d22' }))
  assert.match(manual, /<div class="verb">\/tmp\/資料 A<\/div>/)
  assert.match(manual, /<pre class="msg code">cd 資料<\/pre>/)
  assert.match(manual, /<li>Finder で 資料 A を開く<\/li>/)
  // 利用者がそのまま使う値でない欄（済ませたあと）は詰める。
  assert.match(manual, /開けた2件を確かめる/)
})

test('Codex v3 2: 段に寄せられない工程名の未完了タスクがあれば、今の段も済んだ段も出さず「工程の外あり」', () => {
  const h = page(aoba((v) => {
    v.cockpit!.tasks.push({ id: 't9', stream: 's1', phase: '受入', title: '受け入れ', state: 'run' }, { id: 't10', stream: 's1', phase: 'push', title: '出す', state: 'idle' })
  }))
  const head = h.slice(h.indexOf('<b>配車画面の改修</b>'), h.indexOf('</div>', h.indexOf('<b>配車画面の改修</b>')))
  assert.match(head, /工程の外あり/)
  assert.doesNotMatch(head, /pp on|pp cur|5\/5/)
})

test('Codex v3 3: タスクが全部済でもカードが残る仕事は「タスク完了・確認待ち」。「全工程 完了」は仕事が済のときだけ', () => {
  const h = page(aoba())
  const head = h.slice(h.indexOf('<b>定例と議事録</b>'), h.indexOf('</div>', h.indexOf('<b>定例と議事録</b>')))
  assert.match(head, /タスク完了・確認待ち/)
  assert.doesNotMatch(head, /全工程 完了/)
  const whole = page(aoba((v) => { for (const c of v.cockpit!.cards) if (c.stream === 's4') c.state = 'done' }), { tab: 'whole', open: { done: true } })
  const box = whole.slice(whole.indexOf('定例と議事録'))
  // 全体のタブの仕事の行は、右を工程の 5 語にそろえ、済んだことは状況の行で言う（追加 38）。
  assert.match(text(box.slice(0, box.indexOf('data-talkstream'))), /定例と議事録 全工程 完了 状況 完了/)
  const mine = page(aoba(), { tab: 'whole' })
  assert.match(text(mine.slice(mine.indexOf('定例と議事録'), mine.indexOf('</div>', mine.indexOf('定例と議事録')))), /状況 要対応 1 件 ・タスクはすべて完了/)
})

test('Codex v3 4・5: 属性の値の中の > でタグを切らず、コピーのあとの知らせは今の「送った」ボタンの名前を案内する', () => {
  assert.equal(tighten('<div title="x > 資料 A">文 A</div>'), '<div title="x > 資料 A">文A</div>')
  assert.match(page(aoba(), { sel: '/ws/aoba#d22' }), new RegExp(`data-act="sent"[^>]*>${SENT_LABEL}<`))
  assert.match(copyMessage({ opened: true }), new RegExp(`「${SENT_LABEL}」を押して`))
})

test('追加 20: コピーは素の文字列とスレッドを押したその場で始め、書式の決まる宛先だけ clip-draft で上書きする', async () => {
  const run = async (d: Parameters<typeof copyDraft>[0], o: { clip?: ClipResult | Error; write?: Error; plainOnly?: boolean } = {}) => {
    const log: string[] = []
    const said: string[] = []
    const t = {
      openUrl: async (url: string) => (log.push(`open ${url}`), { opened: true }),
      clip: async (text: string, format: DraftFormat) => {
        log.push(`clip ${format}`)
        if (o.clip instanceof Error) throw o.clip
        return o.clip ?? { copied: true }
      }
    }
    const done = copyDraft(d, t, async (text) => {
      log.push(`write ${text}`)
      if (o.write) throw o.write
    }, (x) => said.push(x), o.plainOnly)
    // await の前に、素の文字列の書き込みとスレッドを開くのが始まっている。
    const sync = [...log]
    const ret = await done
    return { sync, log, said, ret }
  }
  const teams = await run({ to: 'a', via: 'Teams', text: '- **a**', href: 'https://teams.microsoft.com/l/1' })
  assert.deepEqual(teams.sync, ['write - **a**', 'open https://teams.microsoft.com/l/1'])
  assert.deepEqual(teams.log, [...teams.sync, 'clip teams'])
  assert.match(teams.said.at(-1)!, /^本文をTeamsの書式でコピーし、スレッドを開きました/)
  // 書式の決まらない宛先は clip-draft を呼ばない。
  const line = await run({ to: 'a', via: 'LINE', text: 't', href: 'https://line.me/x' })
  assert.deepEqual([line.sync, line.log, line.said], [['write t', 'open https://line.me/x'], ['write t', 'open https://line.me/x'], [copyMessage({ opened: true })]])
  // clip-draft はクリップボードを空にしてから書くので、失敗したら中身を確かめられない。押し直しは素の文字列だけを入れ、スレッドは開き直さない。
  const failed = await run({ to: 'a', via: 'Slack', text: 't', href: 'https://acme.slack.com/x' }, { clip: new Error('swift が無い') })
  assert.equal(failed.ret, true)
  assert.equal(failed.said.at(-1), '本文をSlackの書式に変換できませんでした: swift が無い。クリップボードの中身を確認できないので、もう一度押して素の文字列でコピーしてください')
  const again = await run({ to: 'a', via: 'Slack', text: 't', href: 'https://acme.slack.com/x' }, { plainOnly: true })
  assert.deepEqual([again.ret, again.log, again.said], [false, ['write t'], ['本文を素の文字列でコピーしました']])
  const refused = await run({ to: 'a', via: 'LINE', text: 't' }, { write: new Error('Document is not focused') })
  assert.deepEqual([refused.ret, refused.said], [false, ['本文をコピーできませんでした: Document is not focused。もう一度押してください']])
  // 素の文字列を断られても、書式つきで入れば成功として知らせる。
  const blocked = await run({ to: 'a', via: 'メール', text: '件名: x\n\n本文' }, { clip: { copied: true, subject: 'x' }, write: new Error('Document is not focused') })
  assert.equal(blocked.said.at(-1), '本文をメールの書式でコピーしました。件名は「x」です（本文からは外しました）')
})

test('追加 20: コピーの知らせは宛先の書式・メールの件名を添える', () => {
  assert.equal(copyMessage(undefined, { copied: true, format: 'teams' }), '本文をTeamsの書式でコピーしました')
  assert.equal(copyMessage({ opened: false, reason: 'x' }, { copied: true, format: 'slack' }), '本文をSlackの書式でコピーしましたが、スレッドを開けませんでした: x')
  assert.equal(copyMessage({ opened: true }, { copied: true, subject: '【ご確認】手順書', format: 'mail' }),
    `本文をメールの書式でコピーし、スレッドを開きました。送ったら「${SENT_LABEL}」を押してください。件名は「【ご確認】手順書」です（本文からは外しました）`)
})

test('追加 14: 許可の対象は本文の書体にし、` で囲んだ所と SHA だけを等幅にする（窓とパネル）', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.push({ id: 'p9', rev: 1, kind: 'permit', state: 'open', at: '2026-11-21T09:00:00+09:00', stream: 's1', title: '本番に流す', purpose: '一覧を出す', target: '本番の DB に `migrate 0042` を流す（a1b2c3d）', effect: '一覧の列が増える', undo: '0041 に戻す', why: '今日出す', fallback: '待つ', quote: '出して' })
  })
  const h = page(m, { sel: '/ws/aoba#p9' })
  const f = h.slice(h.indexOf('>対象<'), h.indexOf('>戻し方<'))
  assert.match(f, /<p>本番の DB に <span class="code">migrate 0042<\/span> を流す（<span class="code">a1b2c3d<\/span>）<\/p>/)
  assert.doesNotMatch(f, /<div><span class="code">本番/)
  const panel = render({ ...m, panel: true }, { ...newUi(), sel: '/ws/aoba#p9' }, NOW, (x) => x)
  assert.match(panel, /<span class="lb">対象<\/span><div><div class="rich"><p>本番の DB に <span class="code">migrate 0042<\/span>/)
})

test('仕事の見出しの要対応は、タブと同じく修正待ちを数えない', () => {
  const h = page(aoba((v) => {
    v.log.ops.push({ op_id: 2, at: '2026-11-21T09:40:00+09:00', item_id: 'r5', item_rev: 1, type: 'talk', text: '幅を直して' })
  }))
  const head = h.slice(h.indexOf('<b>配車画面の改修</b>'), h.indexOf('</div>', h.indexOf('<b>配車画面の改修</b>')))
  assert.match(head, /修正待ち 1/)
  assert.doesNotMatch(head, /要対応/)
})

test('Codex 13-4・5: 出した指示の本文は空白を詰めず、古い版への返答は今の選択肢の文言で読み替えない', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.find((x) => x.id === 'd21')!.rev = 2
    v.log.ops.push(
      { op_id: 2, at: '2026-11-21T09:40:00+09:00', item_id: 'd21', item_rev: 1, type: 'decide', option_id: 'keep' },
      { op_id: 3, at: '2026-11-21T09:50:00+09:00', item_id: 'd21', item_rev: 2, type: 'talk', text: 'cd 資料 を 開く' })
  })
  const h = tighten(page(m, { sel: '/ws/aoba#d21' }))
  assert.match(h, /<div class="quote verb">cd 資料 を 開く<\/div>/)
  assert.match(text(h), /決定: keep（版1） 未反映/)
})

test('info-needs Q1・Q2: 判断の一覧の行の 2 行目におすすめの案を出し、本文の判断の記録の番号の括弧は表示から除く', () => {
  assert.match(page(aoba()), /<span class="ti">構成案の本番の図に、社内向けの入口を描き足すか<\/span><\/span><span class="recm">おすすめ: 図はこのまま、本文で説明する<\/span>/)
  assert.equal(dropRulings('<p>窓の版 3（R46・R47、R83）を入れる（2 件）</p>'), '<p>窓の版 3を入れる（2 件）</p>')
  assert.equal(dropRulings('止めないため（21:40 の依頼、R79）。（R12、11/20）'), '止めないため（21:40 の依頼）。（11/20）')
})

test('Codex 17-1・2: 判断の記録の番号を除くのは説明の文だけ。送る文面・コマンド・対象・リンクの値は帳簿のまま（窓とパネル）', () => {
  const m = aoba((v) => {
    const d = v.cockpit!.cards.find((x) => x.id === 'd22')!
    d.purpose = '議事録をそろえる（R46・R47）'
    d.draft!.text = '対象機種（R2、R3）を交換します'
    const r = v.cockpit!.cards.find((x) => x.id === 'r5')!
    r.href = '/tmp/仕様(R2).pdf'
  })
  const send = tighten(page(m, { sel: '/ws/aoba#d22' }))
  assert.match(send, /<div class="msg">対象機種（R2、R3）を交換します<\/div>/)
  assert.match(send, /<p class="purp">議事録をそろえる<\/p>/)
  assert.match(page(m, { sel: '/ws/aoba#r5' }), /data-file="\/tmp\/仕様\(R2\)\.pdf"/)
  const panel = render({ ...m, panel: true }, { ...newUi(), sel: '/ws/aoba#d22' }, NOW, (x) => x)
  assert.match(panel, /対象機種（R2、R3）を交換します/)
  assert.doesNotMatch(panel, /（R46・R47）/)
  const manual = page(aoba((v) => { v.cockpit!.cards.find((c) => c.id === 'd22')!.manual = { where: 'x', command: "tool '部品(R2)'", check: 'y' } }), { sel: '/ws/aoba#d22' })
  assert.match(manual, /tool &#39;部品\(R2\)&#39;/)
})

test('Codex 17-3: 旧形式の許可（context.what・context.gain）も、パネルと窓で対象と影響を出し、窓の詳細で重ねない', () => {
  const m = aoba((v) => {
    v.cockpit!.cards.push({ id: 'p8', rev: 1, kind: 'permit', state: 'open', at: '2026-11-21T09:00:00+09:00', stream: 's1', title: '旧テーブルを消す', purpose: 'p', why: 'w', fallback: 'f', quote: 'q', undo: '戻せない', context: { what: '本番 DB', gain: '旧テーブルを削除' } })
  })
  const panel = render({ ...m, panel: true }, { ...newUi(), sel: '/ws/aoba#p8' }, NOW, (x) => x)
  assert.match(text(panel), /影響 旧テーブルを削除 対象 本番 DB/)
  const win = text(page(m, { sel: '/ws/aoba#p8' }))
  assert.match(win, /何が変わるか 旧テーブルを削除 対象 本番 DB/)
  assert.equal(win.match(/本番 DB/g)!.length, 1)
})

test('Codex 17-4: 依頼の原文の「続き」と済んだことの残りは、開いた状態を再描画のあとも保つ', () => {
  const m = aoba((v) => { v.cockpit!.cards.find((x) => x.id === 'r5')!.request = '1 行目\n2 行目\n3 行目' })
  assert.match(page(m, { sel: '/ws/aoba#r5' }), /<details class="cont" data-fold="cont:\/ws\/aoba#r5"><summary>続き/)
  assert.match(page(m, { sel: '/ws/aoba#r5', open: { 'cont:/ws/aoba#r5': true } }), /data-fold="cont:\/ws\/aoba#r5" open>/)
  const t = aoba((v) => { v.cockpit!.tasks.find((x) => x.id === 't1')!.done = ['a', 'b', 'c', 'd'] })
  assert.match(page(t, { tab: 'whole', task: 't1', open: { 'done:t1': true } }), /data-fold="done:t1" open><summary>残り 1 件/)
})

test('追加 22 の Codex: 全体の j・k の順は見張るを最後にした画面の順と同じ。選べるタスクの無い仕事は仕事の詳細から協議できる。期限は一覧と詳細で同じ語と色', () => {
  const m = aoba((v) => { v.cockpit!.streams[2]!.form = 'watch' })
  const all = page(m, { tab: 'whole', open: { 's:s1': true, 's:s2': true, 's:s3': true } })
  const order = taskOrder(m.boards[0])
  assert.deepEqual(order, [...all.matchAll(/data-task="(\w+)"/g)].map((x) => x[1]))
  assert.equal(order.at(-1), 't3', '見張る仕事（s3）のタスクは最後')
  assert.match(page(aoba(), { tab: 'whole', stream: 's4' }).split('<aside')[1]!, /data-talkstream="s4"/)
  // d21 は 3 時間後、d22 は 2 時間前が期限。赤は期限切れだけで、詳細もパネルの「あと n 時間」の赤い札にしない。
  const d = page(aoba(), { sel: '/ws/aoba#d21' })
  assert.doesNotMatch(d, /due hot/)
  assert.equal(d.match(/class="due dnext soon"/g)?.length, 2, '一覧と詳細の 2 か所')
  assert.match(text(d), /期限切れ 08:00/)
})

test('詳細の担当の行は、端末・チャットを前に出すボタンにする（チャットは居場所の worktree が分かるときだけ）', () => {
  const m = aoba((v) => {
    v.owners = [{ session: 'sess-aws', kind: 'chat', state: 'working', worktree: '/ws/aoba-aws' }]
  })
  // 担当の名前が仕事の名前（AWS 構成案）と同じなら名前を重ねない（初見 2 巡目 3）。
  assert.match(page(m, { sel: '/ws/aoba#d21' }), /<span class="owner"><span>担当<\/span>(<span>[^<]*<\/span>)?<button type="button" class="act" data-term="" data-wt="\/ws\/aoba-aws" data-who="[^"]+の担当">チャットを開く<\/button>/)
  assert.match(page(m, { sel: '/ws/aoba#r5' }), /<button type="button" class="act" data-term="term_aoba_w1" data-wt="" data-who="[^"]+の担当">端末を開く<\/button>/)
  // 前に出せないときは「チャット」を押せない語として並べない。
  assert.doesNotMatch(page(aoba(), { sel: '/ws/aoba#d21' }), /<span>チャット<\/span>/)
})

test('補助の文字・危険・仕事の形の色は、明暗どちらの地でも WCAG AA（4.5:1）を満たし、押せるものの枠は 3:1 を満たす', () => {
  const vars = (sel: string) => Object.fromEntries([...CSS.split(sel)[1]!.split('}')[0]!.matchAll(/--([\w-]+):(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]))
  const light = vars('.ck { color-scheme: light;')
  const dark = { ...light, ...vars('.ck[data-theme="dark"] { color-scheme: dark;') }
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
  }
  const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
  for (const t of [light, dark])
    for (const bg of ['bg', 'surface', 'sunk', 'hot-bg']) {
      for (const fg of ['ink', 'ink2', 'ink3', 'focus', 'hot', 'f-delegate', 'f-cowork', 'f-watch']) assert.ok(ratio(t[fg]!, t[bg]!) >= 4.5, `${fg} / ${bg}: ${ratio(t[fg]!, t[bg]!).toFixed(2)}`)
    }
  assert.match(CSS, /\.ck \.btn \{[^}]*border:1px solid var\(--ink3\)/)
  assert.match(CSS, /\.ck\.win \.act \{[^}]*border:1px solid var\(--ink3\)/)
})

test('問いの件名が題のときは、詳細に本文も出す', () => {
  const m = aoba((v) => {
    v.questions = [{ id: 'q1', at: NOW - 10 * 60_000, line: '仕様確認', text: '端数は切り上げますか？', to: 'main', task: 't1' }]
  })
  assert.match(page(m, { sel: '/ws/aoba##ask:q1' }), /聞かれていること.*端数は切り上げますか？/s)
})

test('初見 2 巡目: 仕事の見出しは工程を名前の横に置き、右の列は行の期限だけ。担当が仕事と同じ名前なら出さない', () => {
  const h = page(aoba(), {})
  const head = h.slice(h.indexOf('<div class="gh f-'), h.indexOf('</div>', h.indexOf('<div class="gh f-')))
  // 名前 → 工程 → 件数の順（工程が右端に寄らない）。
  assert.match(head, /<b>[^<]+<\/b><span class="prog"><span class="pbar"[^>]*>[^<]*(工程|タスク完了)/)
  const all = [...h.matchAll(/<div class="gh f-[^"]*">([\s\S]*?)<\/div>/g)].map((x) => text(x[1]!))
  assert.ok(all.every((x) => !/担当: (配車画面の改修|AWS 構成案)/.test(x)), all.join('\n'))
})

test('初見 2 巡目: 対応済みは答えを「出した指示」の 1 行で読み、囲みの箱と行の右の「決定: 〜」を出さない', () => {
  const h = page(aoba(), { tab: 'done', doneSel: '/ws/aoba#d19' })
  assert.doesNotMatch(h, /class="note ok"/)
  const row = h.slice(h.indexOf('data-dsel="/ws/aoba#d19"'), h.indexOf('</button>', h.indexOf('data-dsel="/ws/aoba#d19"')))
  assert.doesNotMatch(text(row), /決定/)
  // 畳んだ「詳細」の中（頼んだ選択肢）は数えない。
  const shown = h.replace(/<details class="more-d"[\s\S]*?<\/details>/, '')
  assert.equal(text(shown).match(/議題だけテキストで送る/g)?.length, 3, '行の題・詳細の題・出した指示')
})

test('Codex 初見 2 巡目: 協議の開始だけが記録され、答えは帳簿で閉じたカードは、結果の 1 行で答えを出す', () => {
  const m = aoba((v) => {
    v.log.ops = v.log.ops.filter((o) => o.item_id !== 'd19')
    v.log.ops.push({ op_id: 90, at: new Date(NOW - 40 * 3_600_000).toISOString(), item_id: 'd19', item_rev: 1, type: 'talk' })
  })
  const t = text(page(m, { tab: 'done', doneSel: '/ws/aoba#d19' }))
  assert.match(t, /出した指示 .*協議を開始/)
  assert.match(t, /結果 決定: 議題だけテキストで送る/)
})

test('Codex 初見 2 巡目 2: 前の版への答えしか記録が無ければ、今の版の答えを結果の 1 行で出す', () => {
  const m = aoba((v) => {
    const d19 = v.cockpit!.cards.find((x) => x.id === 'd19')!
    d19.rev = 2
  })
  const t = text(page(m, { tab: 'done', doneSel: '/ws/aoba#d19' }))
  assert.match(t, /出した指示 .*（版 1）/)
  assert.match(t, /結果 決定: 議題だけテキストで送る/)
})

test('初見 2 巡目: 見張るの経路は線の一覧で「最終確認 hh:mm」。詳細の操作の帯はいつも下端（縦の flex）', () => {
  const t = text(page(aoba(), { tab: 'whole' }))
  assert.match(t, /Slack #aoba-dev 最終確認 /)
  assert.doesNotMatch(t, /に読んだ/)
  assert.match(CSS, /\.ck\.win \.wdet \{ display:flex; flex-direction:column; min-height:100%; \}/)
  assert.match(CSS, /\.ck\.win \.dbtn \{ margin-top:auto;/)
})

test('初見 2 巡目: タスクのエージェントが停止で要対応に出ていれば、全体の行と詳細の状態も停止と出す（作業中と「停止を開く」を並べない）', () => {
  const m = aoba((v) => {
    v.questions = [{ id: 'q1', at: NOW - 10 * 60_000, line: '仕様確認', text: '端数は切り上げますか？', to: 'main', task: 't1' }]
  })
  const h = page(m, { tab: 'whole', task: 't1' })
  const row = h.slice(h.indexOf('data-task="t1"'), h.indexOf('</div>', h.indexOf('data-task="t1"')))
  assert.match(row, /<span class="tst s-stop">停止<\/span>/)
  assert.match(row, /停止を開く/)
  assert.match(h, /<div class="kl"><span class="tst s-stop">停止<\/span>/)
  // 進め手の worker と仕事の行の件数も停止にそろえる。
  assert.match(h, /<span class="mut">worker<\/span><b>[^<]*<\/b><span class="chip bad">停止<\/span>/)

  // 停止の無いときは帳簿のまま。
  assert.match(page(aoba(), { tab: 'whole', task: 't1' }), /<div class="kl"><span class="tst s-run">作業中<\/span>/)
})

test('工程は 5 つの語を並べて今の段を太字にする（R126・R135）。前の和語の名前の帳簿もそのまま同じ段に寄せ、5 つの外は名指しする', () => {
  assert.deepEqual([...STAGES], ['調査', '決定', '作成', '確認', '反映'])
  for (const [old, now] of [['調べる', '調査'], ['決める', '決定'], ['要件', '決定'], ['作る', '作成'], ['実装', '作成'], ['確かめる', '確認'], ['見てもらう', '確認'], ['入れる', '反映'], ['push', '反映']] as const) assert.equal(stageOf(old), now)
  assert.equal(stageOf('調整'), undefined)
  const h = stagesHtml(2, true)
  assert.match(h, /<span class="sd">調査<\/span>.*<span class="sd">決定<\/span>.*<b class="sc">作成<\/b>.*<span class="sn">確認<\/span>.*<span class="sn">反映<\/span>/)
  assert.match(h, /<span class="stg-now">工程 <b>作成<\/b><\/span>/, '一覧の行の狭い形は今の段の語だけ（「工程」を添える）')
  assert.doesNotMatch(stagesHtml(2), /stg-now/, '詳細はいつも 5 語')
  assert.match(CSS, /\.ck \.stg \.sd \{ color:var\(--ink3\); \}/)
  assert.match(CSS, /\.ck \.stg \.sn \{ color:var\(--ink2\); \}/)
  assert.match(CSS, /@media \(max-width: 1100px\) \{\n  \.ck\.win \.pbar \.stg-all \{ display:none; \}/)
  const t = text(page(aoba((v) => { v.cockpit!.tasks.find((x) => x.id === 't1')!.phase = '調整' }), { tab: 'whole', task: 't1' }))
  assert.match(t, /工程の外（調整）/)
})

test('追加 25: 見てのカードに見本（draft）があれば、窓とパネルの詳細に宛先ごとの書式でコピーする 3 つのボタンを出す。押すと素の文字列を入れてからその書式で上書きし、スレッドは開かない', async () => {
  const w = sample(NOW)[2]!
  const v: CockpitView = { state: 'ok', root: '/ws/harness', cockpit: parseCockpit(JSON.stringify(w.cockpit)), log: structuredClone(w.log), archive: [], figures: {}, errors: [], workers: [], notifiedOp: 0 }
  const m: Model = { boards: boardsOf([v], NOW), focused: '/ws/harness', unseen: [], errors: [] }
  const copies = (h: string) => [...h.matchAll(/data-act="copyas" data-format="(\w+)" data-key="\/ws\/harness#r9">([^<]+)</g)].map((x) => `${x[1]}:${x[2]}`)
  const want = ['slack:Slackの書式でコピー', 'teams:Teamsの書式でコピー', 'mail:メールの書式でコピー']
  assert.deepEqual(copies(page(m, { sel: '/ws/harness#r9' })), want)
  assert.deepEqual(copies(render(m, { ...newUi(), sel: '/ws/harness#r9' }, NOW, (x) => x)), want)
  assert.deepEqual(copies(page(m, { sel: '/ws/harness#r8' })), [], '見本の無い見ては出さない')
  for (const f of ['slack', 'teams', 'mail'] as const) {
    const log: string[] = []
    const d = copyTarget({ ...v.cockpit!.cards.find((x) => x.id === 'r9')!.draft!, href: 'https://example.slack.com/x' }, f)
    await copyDraft(d, { openUrl: async (u) => (log.push(`open ${u}`), { opened: true }), clip: async (_t, g) => (log.push(`clip ${g}`), { copied: true }) }, async () => void log.push('write'), () => {})
    assert.deepEqual(log, ['write', `clip ${f}`])
  }
})

test('追加 27・29: 一緒に作る仕事は要対応に 1 行。返事待ちなら先頭が「答える」（窓から担当に返事を送れる。d209）で札が付き、開くボタンは担当のチャット。全体の仕事とタスクの状態も「返事待ち（あなた）」', () => {
  const m = (state: 'working' | 'done') => aoba((v) => {
    v.cockpit!.streams.find((x) => x.id === 's2')!.form = 'cowork'
    v.cockpit!.cards = v.cockpit!.cards.filter((x) => x.stream !== 's2')
    v.owners = [{ session: 'sess-aws', kind: 'chat', state, worktree: '/ws/aoba-aws', updatedAt: NOW - 60_000, last: '構成案の下書きです。\n\n入口は社内向けにも描きますか？' }]
  })
  const asked = page(m('done'), { sel: '/ws/aoba##cowork:s2' })
  const rowOf = (h: string) => h.match(/<[^>]*data-sel="\/ws\/aoba##cowork:s2"[\s\S]*?<\/button>/)?.[0] ?? ''
  assert.match(rowOf(asked), /<span class="kd">答える<\/span>/)
  assert.match(asked, /data-sel="\/ws\/aoba#r5"[^>]*>\s*<span class="kd">承認・直し<\/span>/)
  assert.match(text(rowOf(asked)), /入口は社内向けにも描きますか？/)
  assert.match(rowOf(asked), /class="tag miss">返事待ち（あなた）</)
  assert.match(asked, /data-act="focus"[^>]*>担当のチャットを開く</)
  const whole = text(page(m('done'), { tab: 'whole', open: { 's:s2': true } }))
  assert.match(whole, /AWS 構成案 [^状]*状況 返事待ち（あなた）/)
  assert.match(whole, /返事待ち（あなた） 構成案の図と本文/)
  const calm = page(m('working'), { sel: '/ws/aoba##cowork:s2' })
  assert.match(rowOf(calm), /<span class="kd">確認<\/span>/)
  assert.match(text(rowOf(calm)), /共同作業中（担当は作業中）/)
  assert.doesNotMatch(rowOf(calm), /返事待ち/)
})

const talk = (v: CockpitView, id: string) =>
  v.log.ops.push({ op_id: 901, at: '2026-11-21T00:00:00.000Z', item_id: id, item_rev: v.cockpit!.cards.find((x) => x.id === id)!.rev, type: 'talk' })

test('要対応の行の札は題の横に置かず（2 行に折り返した題に割り込んで分断する）、2 行目の先頭に「札・2 行目の文」の形で置く。決める行はおすすめの行の先頭、2 行目の無い行は札だけの 2 行目にする', () => {
  const m = aoba((v) => {
    v.cockpit!.streams.find((x) => x.id === 's2')!.form = 'cowork'
    v.cockpit!.cards = v.cockpit!.cards.filter((x) => x.stream !== 's2')
    v.owners = [{ session: 'sess-aws', kind: 'chat', state: 'done', worktree: '/ws/aoba-aws', updatedAt: NOW - 60_000, last: '定例では、費用の見積もりを先に説明しますか、それとも構成図から説明しますか？' }]
    talk(v, 'd22')
  })
  // 決める d21 は s2 の札なので別の窓で協議中にする。
  const h = page(m) + page(aoba((v) => talk(v, 'd21')))
  const rowOf = (key: string) => h.match(new RegExp(`<[^>]*data-sel="${key}"[\\s\\S]*?</button>`))?.[0] ?? ''
  for (const key of ['/ws/aoba##cowork:s2', '/ws/aoba#d22', '/ws/aoba#d21']) assert.match(rowOf(key), /<span class="tl"><span class="ti">[^<]*<\/span><\/span>/, `${key} の題の行に札が無い`)
  assert.match(rowOf('/ws/aoba##cowork:s2'), /<span class="crumb"><span class="tag miss">返事待ち（あなた）<\/span>・担当（AWS 構成案）があなたの返事を待っている・1 分前から<\/span>/)
  assert.match(rowOf('/ws/aoba#d22'), /<span class="crumb"><span class="tag talk">協議中<\/span><\/span>/)
  // 決める行はおすすめの行が 2 行目なので、その先頭に置く（札だけの 3 行目を作らない）。
  assert.match(rowOf('/ws/aoba#d21'), /<span class="recm"><span class="tag talk">協議中<\/span>・おすすめ: [^<]+<\/span><\/span>/)
  assert.doesNotMatch(CSS, /\.cardrow \.tl \.tag/)
})

test('要対応の行の番号（追加 40・R67）: 一覧の行には出さず、詳細の下に小さく置く。Orca から作った行は指すタスク、一緒に作る仕事の行は仕事の id。右の列は期限だけ', () => {
  const h = page(aoba())
  const list = h.slice(h.indexOf('class="wpane"'), h.indexOf('aria-label="詳細"'))
  assert.doesNotMatch(list, /class="cid"|番号/)
  for (const id of ['d22', 'd21', 'c4', 'r5']) assert.match(page(aoba(), { sel: `/ws/aoba#${id}` }), new RegExp(`<p class="rid">番号<code>${id}</code></p>`))
  assert.match(list, /data-sel="\/ws\/aoba#d22"[\s\S]*?<span class="du"><span class="due dover">期限切れ 08:00<\/span><\/span><\/button>/)
  assert.match(list, /data-sel="\/ws\/aoba#c4"[\s\S]*?<span class="du"><\/span><\/button>/, '期限の無い行は右の列を空ける')
  assert.equal(rowId({ card: { id: '#agent:term_x', tasks: ['t5'], stream: 's1' } as never }), 't5')
  assert.equal(rowId({ card: { id: '#cowork:s2', stream: 's2', tasks: ['t1', 't2'] } as never }), 's2', '一緒に作る仕事の行は、先頭のタスクではなく仕事を指す')
  assert.equal(rowId({ card: { id: '#ask:msg_q1', stream: 's2' } as never }), undefined)
})

test('放置の行（追加 35）: 要対応に「確認」の 1 行で何時間動いていないかを出し、詳細に最後の動き・worker と担当の今・帳簿の次と、タスクの詳細を開くボタン', () => {
  const m = aoba((v) => {
    const s = v.cockpit!.streams[0]!.id
    v.cockpit!.tasks.push({ id: 'k9', stream: s, phase: '作成', title: '帳票を作る', state: 'run', next: '帳票の列を決める' })
    v.taskSeen = { k9: { sig: taskSig(v.cockpit!.tasks.at(-1)!), at: new Date(NOW - 3 * 3_600_000).toISOString() } }
    v.terminals = []
  })
  const h = page(m, { sel: '/ws/aoba##idle:k9' })
  assert.match(h, /data-sel="\/ws\/aoba##idle:k9"[\s\S]*?<span class="kd[^"]*">確認<\/span>[\s\S]*?「帳票を作る」が3時間動いていない/)
  const det = text(h.slice(h.indexOf('aria-label="詳細"')))
  assert.match(det, /最後の動き .*（帳簿の更新）。作業中のまま2時間を超えたので出しています/)
  assert.match(det, /worker・担当 worker なし/)
  assert.match(det, /次にやること 帳票の列を決める/)
  assert.match(det, /対応のしかた 「担当と話す」で止まっている理由を聞き/)
  assert.match(h, /data-tab="whole" data-task="k9">タスクの詳細を開く/)
  assert.match(h, /<p class="rid">番号<code>k9<\/code><\/p>/, '放置の行の番号はタスクの id')
})

test('見張る仕事の頻度（R152）: cron の 5 欄と RRULE の主な形を語にし、読めない形はそのまま出す', () => {
  assert.equal(rruleText('0,30 9-19 * * *'), '毎日 9〜19 時 30 分おき')
  assert.equal(rruleText('*/15 * * * *'), '毎日 15 分おき')
  assert.equal(rruleText('0 8 * * 1-5'), '平日 8:00')
  assert.equal(rruleText('5 9-18 * * 1,3'), '月・水 9〜18 時の毎時 5 分')
  assert.equal(rruleText('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0'), '平日 8:00')
  assert.equal(rruleText('FREQ=DAILY;BYHOUR=9,17;BYMINUTE=30'), '毎日 9:30・17:30')
  assert.equal(rruleText('FREQ=HOURLY;INTERVAL=2'), '2 時間おき')
  assert.equal(rruleText('0 9 1 * *'), '0 9 1 * *')
  assert.equal(rruleText('FREQ=MONTHLY;BYMONTHDAY=1'), 'FREQ=MONTHLY;BYMONTHDAY=1')
  // 曜日の無い毎週は「毎日」にしない。解釈していない制約が付くものは原文（Codex 5）。
  assert.equal(rruleText('FREQ=WEEKLY;BYHOUR=8'), '毎週 8:00')
  assert.equal(rruleText('FREQ=DAILY;BYHOUR=8;BYMONTH=1'), 'FREQ=DAILY;BYHOUR=8;BYMONTH=1')
  assert.equal(rruleText('FREQ=HOURLY;BYMINUTE=15'), 'FREQ=HOURLY;BYMINUTE=15')
})

test('見張る仕事の表（R152）: 全体のタブに Bot・受け持つ案件・対象・頻度・送り先・前回の結果を並べ、押すと右に出力の全文と実行のチャットを開くボタン。Orca に無い Bot は名指しする', () => {
  const watch = (id: string, automation: string) => ({ id, title: `見回り ${id}`, form: 'watch' as const, watch: { automation, targets: ['管理表', 'Slack #dev'], to: '青葉の窓口' } })
  const m = aoba((v) => {
    v.cockpit!.streams.push(watch('v1', 'auto-1'), watch('v2', 'auto-gone'))
    v.automations = [
      { id: 'auto-1', name: '管理表・Slack 見回り', rrule: '0,30 9-19 * * *', enabled: true, nextRunAt: NOW + 20 * 60_000, last: { status: 'completed', at: NOW - 30 * 60_000, content: '## 結果\n新着は 2 件です。返事が要るものはありません。\n\n- **管理表**: No.12', chat: 'orca_session_id:sess-bot' } },
      { id: 'auto-gone' }
    ]
  })
  const h = page(m, { tab: 'whole' })
  const t = text(h)
  assert.match(t, /見張る仕事 2 件/)
  assert.match(t, /管理表・Slack 見回り 毎日 9〜19 時 30 分おき 対象 管理表・Slack #dev 送り先 青葉の窓口 前回の結果 09:30 完了。新着は 2 件です。返事が要るものはありません。/)
  assert.doesNotMatch(t, /青葉物流 配車アプリ 対象/, '案件の窓では受け持つ案件を出さない')
  assert.match(t, /見回り v2 対象 管理表・Slack #dev 送り先 青葉の窓口 Orca に設定が無く、動いていない/)
  const d = page(m, { tab: 'whole', watch: '/ws/aoba#v1' })
  assert.match(d, /aria-label="見張る仕事の詳細"/)
  assert.match(text(d), /出力 .*新着は 2 件です。返事が要るものはありません。/)
  assert.match(d, /data-term="orca_session_id:sess-bot">この実行のチャットを開く/)
  assert.match(text(page(m, { tab: 'whole', watch: '/ws/aoba#v2' })), /Orca にこの Bot の設定が無く、動いていません（設定の id auto-gone）/)
  // Orca を読めていなければ、読めていないと出す（無いとは言わない）。
  assert.match(text(page(aoba((v) => void v.cockpit!.streams.push(watch('v1', 'auto-1'))), { tab: 'whole' })), /Orca から読めていない/)
})

test('見張る仕事の表（R190）: どの案件の窓も、その案件の帳簿の見張る仕事だけを出す（ハーネス（nix-darwin）の窓にもほかの案件の分を集めない）。受け持つ案件の名は出さない', () => {
  const w = sample(NOW)
  const view = (root: string, i: number, sid: string): CockpitView => {
    const c = parseCockpit(JSON.stringify(w[i]!.cockpit))
    c.streams.push({ id: sid, title: `見回り ${sid}`, form: 'watch', watch: { automation: `auto-${sid}`, targets: ['対象'], to: '窓口' } })
    return { state: 'ok', root, cockpit: c, log: structuredClone(w[i]!.log), archive: [], figures: {}, errors: [], workers: [], notifiedOp: 0, automations: [{ id: `auto-${sid}`, name: `Bot ${sid}` }] }
  }
  const m: Model = { boards: boardsOf([view('/ws/aoba', 0, 'va'), view('/Users/x/.config/nix-darwin', 2, 'vh')], NOW), focused: '/ws/aoba', unseen: [], errors: [] }
  const shown = (filter: string) => text(renderWindow(m, { ...newUi(), tab: 'whole', filter }, NOW, (s) => s))
  const harness = shown('/Users/x/.config/nix-darwin')
  assert.match(harness, /見張る仕事 1 件 Bot vh /)
  assert.doesNotMatch(harness, /Bot va/)
  assert.doesNotMatch(harness, /青葉物流 配車アプリ 対象/)
  assert.match(shown('/ws/aoba'), /見張る仕事 1 件 Bot va /)
  assert.doesNotMatch(shown('/ws/aoba'), /Bot vh/)
})

test('確認日の印（R142・R204 の date の待ち）: 済んでいないタスクに「確認日 11/24(火)」を一覧と詳細に出し、日付が来たら太くする。済んだタスクには出さない', () => {
  const m = aoba((v) => {
    const day = (id: string, on: string) => (v.cockpit!.tasks.find((t) => t.id === id)!.wait = { kind: 'date', on, what: '確かめる' })
    day('t2', '2026-11-24')
    day('t3', '2026-11-21')
    day('t4', '2026-11-21')
  })
  const h = page(m, { tab: 'whole', open: { 's:s2': true, 's:s3': true, 's:s4': true } })
  assert.match(h, /<span class="chk">確認日 11\/24\(火\)<\/span>/)
  assert.match(h, /<b class="chk">確認日 11\/21\(土\)<\/b>/)
  assert.equal((h.match(/class="chk"/g) ?? []).length, 2, '済んだ t4 には出さない')
  assert.match(page(m, { tab: 'whole', task: 't2' }), /<div class="kl">.*<span class="chk">確認日 11\/24\(火\)<\/span><\/div>/s)
})

test('上の帯と詳細の小さな部品（t148）: 対応済み 0 件は数を出さない。枠の無いボタンは押せないときも枠を出さない。「次へ」と「詳細」は下線。事実の欄のラベルの列は 8 字が入る幅', () => {
  const none = page(aoba((v) => { v.cockpit!.cards = v.cockpit!.cards.filter((x) => !x.resolved_at) ; v.archive = [] }))
  assert.match(none, /data-tab="done" aria-selected="false">対応済み<\/button>/)
  assert.match(page(aoba()), /data-tab="done" aria-selected="false">対応済み<span class="n z">1<\/span>/)
  assert.match(CSS, /\.ck \.btn\.quiet:disabled \{[^}]*border-color:transparent;[^}]*text-decoration:none/)
  assert.match(CSS, /\.ck\.win \.dh \.crumbs \.nxl \{[^}]*text-decoration:underline/)
  assert.match(CSS, /\.ck\.win details\.more-d summary \{[^}]*text-decoration:underline/)
  assert.match(CSS, /\.ck\.win \.facts \.fld \{ grid-template-columns:calc\(var\(--fs-xs\) \* 8\.5\)/)
})
