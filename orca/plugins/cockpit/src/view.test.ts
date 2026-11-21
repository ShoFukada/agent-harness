import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { parseCockpit } from './model.ts'
import { harness } from '../fixtures/harness.ts'
import type { AgentRow, CockpitView, WsRow } from './protocol.ts'
import { figureWidth, linkHtml, linkKind, render, richText, type Ui } from './view.ts'
import { renderWindow } from './window-view.ts'

const NOW = new Date('2026-11-16T12:00:00+09:00').getTime()
const sample = () => parseCockpit(readFileSync(new URL('../fixtures/sample.json', import.meta.url), 'utf8'))
const base = (over: Partial<CockpitView> = {}): CockpitView => ({
  state: 'ok', root: '/w', cockpit: sample(), log: { ops: [] }, archive: [], figures: {}, errors: [], workers: [], notifiedOp: 0, replies: [], ...over
})
const ui = (over: Partial<Ui> = {}): Ui => ({ tab: 'todo', pick: {}, showDone: {}, ...over })
const noMatch = (s: string, re: RegExp) => assert.ok(!re.test(s), `${re} に当たってはいけない`)
const draw = (v: CockpitView, u: Ui = ui(), now = NOW) => render(v, u, now, (s) => s)
/** 選んだ項目の詳細の欄だけ。 */
const detailOf = (html: string) => html.slice(html.indexOf('<div class="detail">'))

test('ファイルが無いワークスペースでは、メインに作らせる一言を出す', () => {
  const html = draw(base({ state: 'missing', cockpit: undefined }))
  assert.match(html, /このワークスペースには操縦席がありません/)
  assert.match(html, /cockpit skill で操縦席を作って/)
})

test('上に「前にも言った」のボタンを置き、メインを引き継いだ知らせは 1 日だけ出す', () => {
  assert.match(draw(base()), /data-repeat[^>]*>前にも言った</)
  const handoff = { at: '2026-11-16T09:00:00+09:00', reason: '窓の「前にも言った」が 2 回押された' }
  assert.match(draw(base({ handoff })), /メインを新しいチャットに引き継ぎました（[^）]*・窓の「前にも言った」が 2 回押された）/)
  noMatch(draw(base({ handoff }), ui(), NOW + 86_400_000), /新しいチャットに引き継ぎました/)
})

test('決める: 選ぶ前は「選択肢を選ぶ」（押せない）、選んだ後は「この案で決める」', () => {
  assert.match(draw(base(), ui({ cur: 'd1' })), /<button class="btn pri" data-decide disabled>選択肢を選ぶ<\/button>/)
  const html = draw(base(), ui({ cur: 'd1', pick: { 'd1@1': 'auto' } }))
  assert.match(html, /data-decide title="「システムが自動で割り当てる」で決める">この案で決める<\/button>/)
})

test('印は墨色の「判断」「質問」「確認」。朱は期限が 24 時間以内か過ぎた項目だけ', () => {
  const html = draw(base(), ui({ cur: 'd1' }))
  assert.match(html, /<span class="kind k-dec hot"[^>]*>判断<\/span><span class="due[^]*?<\/span><\/span><\/span><span><span class="t">通知メールの差出人を決める/)
  assert.match(html, /! あと 22 時間 11\/17\(火\) 10:00/)
  assert.match(html, /<span class="kind k-dec"[^>]*>判断<\/span><span class="due[^]*?<\/span><\/span><span><span class="t">担当者の割り当て方を決める/)
  assert.match(html, /<span class="kind k-rev"[^>]*>確認<\/span>/)
  assert.match(html, /<span class="kind k-ask"[^>]*>質問<\/span>/)
  assert.equal((html.match(/kind k-\w+ hot/g) ?? []).length, 1, '一覧の d4 だけ（詳細は d1）')
  assert.match(draw(base(), ui(), new Date('2026-11-19T09:00:00+09:00').getTime()), /! 期限切れ 11\/18\(水\) 18:00/)
})

test('件数は決める・聞く・見ての合計と内訳。報告（ack）と依頼は数えず、報告は関係する大タスクの下に並ぶ', () => {
  const html = draw(base())
  assert.match(html, /要対応 <b class="num">7<\/b> 件<span class="brk">（判断 <span class="num">4<\/span> 件・質問 <span class="num">1<\/span> 件・確認 <span class="num">2<\/span> 件）<\/span>/)
  assert.match(html, /data-tab="todo" aria-selected="true">要対応<\/button>/)
  // 大タスクの見出しごとに、中のいちばん近い期限の順（通知 11/17 → 一覧画面 11/18 → データ移行 11/21）
  assert.match(html, /data-stream="s2"><span class="shn">通知<\/span>[^]*data-stream="s1"><span class="shn">一覧画面<\/span>[^]*data-stream="s3"/)
  // 報告は畳まず、それぞれの大タスクのまとまりの中で判断・確認・質問の後に並ぶ
  for (const id of ['a2', 'a3', 'a4']) assert.match(html, new RegExp(`data-id="${id}"`))
  noMatch(html, /data-reports/)
  for (const g of html.match(/<section class="sgrp">[^]*?<\/section>/g) ?? []) {
    const kinds = [...g.matchAll(/class="kind k-(\w+)/g)].map((m) => m[1])
    assert.deepEqual(kinds, [...kinds.filter((k) => k !== 'ack'), ...kinds.filter((k) => k === 'ack')], '報告はまとまりの最後')
  }
  noMatch(html, /<kbd>/)
  assert.match(draw(base(), ui({ keys: true })), /<kbd>j<\/kbd>/)
  noMatch(render(base(), ui(), NOW, (s) => s, true), /要対応 <b class="num">/)
})

test('報告だけ残っていれば件数は 0 件で、報告は大タスクの下に並んで最初の 1 件が開く', () => {
  const c = sample()
  c.items = c.items.filter((i) => i.kind === 'ack' || i.state === 'done')
  const html = draw(base({ cockpit: c }))
  assert.match(html, /要対応 <b class="num">0<\/b> 件/)
  assert.match(html, /class="shead"[^]*data-id="a\d"/)
  assert.match(html, /data-ack>確認した/)
})

test('判断のページ: たどり → 何のため → なぜ今決めるか → 決めるための情報（開いた状態）→ 選択肢（例 1 行）→ 返答。背景と比較は閉じた詳細の欄', () => {
  const html = detailOf(draw(base(), ui({ cur: 'd1' })))
  const at = (re: RegExp) => html.search(re)
  // 期限とたどりは左の一覧の行と同じなので、詳細の頭には種類の印だけを出す
  // 上にたどり（全体 › 代表の大タスク › タスク）と、ほかに関係する大タスク。どれも押せる
  assert.match(html, /<div class="detail"><nav class="crumbs" aria-label="たどり"><button class="tlink" data-whole>全体<\/button>[^]*data-stream="s1">一覧画面<\/button>[^]*data-task="t1">[^<]+<\/button><\/nav><div class="also">ほかに関係する大タスク <button class="tlink" data-stream="s2">通知<\/button><\/div><div class="meta mut"><span class="kind k-dec"[^>]*>判断<\/span><\/div>/)
  noMatch(detailOf(html), /期限 11\/18/)
  assert.ok(at(/class="goal"><span class="lbl">目的<\/span>担当者が、今日対応する/) < at(/<h2 class="vh">担当者の割り当て方を決める/))
  assert.ok(at(/<h2 class="vh">/) < at(/>今決める理由<\/div>一覧画面の設計がこの判断で止まっている/))
  assert.ok(at(/>今決める理由</) < at(/data-ctx="d1" aria-expanded="true"/))
  const ctxOrder = ['概要', '現状', '対応案', '効果', '懸念点'].map((h) => at(new RegExp(`<div class="h">${h}</div>`)))
  assert.deepEqual([...ctxOrder].sort((a, b) => a - b), ctxOrder)
  assert.ok(ctxOrder[0]! > 0 && ctxOrder[4]! < at(/>選択肢</))
  assert.match(html, /<div class="h">現状<\/div><div class="rt-box"><ul class="rt"><li>毎朝 9 時に主任が全件を見て/) // 欄の中の箇条
  noMatch(html, /判断材料が足りません/)
  assert.match(html, /<b>システムが自動で割り当てる<\/b>[^]*?<div class="ex"><span class="exl">例<\/span>30 件 → 5 人に 6 件ずつ<\/div>/)
  noMatch(html, /朝の振り分け作業が無くなる/) // 選択肢の理由（body）は詳細の欄へ
  assert.ok(at(/>選択肢</) < at(/data-more="d1" aria-expanded="false">.*詳細<span class="mut">（背景・比較・タスク）/))
  noMatch(html, />背景<\/div>|class="cmp"/)
  // 回答が無い場合の注記は、下端に留める返答の列ではなく、その直前の本文に置く
  assert.match(html, /<div class="fbline mut">回答が無い場合: 一覧画面の設計は止めたまま[^<]*<\/div><div class="acts">[^]*<button class="link jump" data-jump="d1">背景と比較を開く<\/button>/)
  noMatch(html, /そもそも/)
})

test('詳細の欄を開くと、背景・選択肢ごとの影響・選択肢の理由・関係するタスクの順に出し、飛ぶボタンは消す（決の why は上の「なぜ今決めるか」）', () => {
  const html = detailOf(draw(base(), ui({ cur: 'd1', more: { d1: true } })))
  const at = (re: RegExp) => html.search(re)
  assert.match(html, /data-more="d1" aria-expanded="true"/)
  assert.ok(at(/>背景<\/div>今は朝 9 時に/) < at(/>選択肢ごとの影響</))
  assert.match(html, /<table class="cmp"><thead><tr><th><\/th><th>朝の振り分け<\/th>[^]*<th>自動で割り当てる<\/th><td>無くなる<\/td>/)
  assert.ok(at(/<\/table>/) < at(/<svg[^>]*aria-label="月曜の朝に30件/) && at(/<svg/) < at(/>選択肢の理由</)) // 比較の表と図は両方出す
  assert.ok(at(/>選択肢ごとの影響</) < at(/>選択肢の理由</))
  assert.ok(at(/>選択肢の理由</) < at(/>関係するタスク</))
  noMatch(html, />判断による影響</)
  noMatch(html, /data-jump/)
})

test('決めるための情報の欄が欠けた決は、一覧の行と詳細の頭に名指しで出し、決めるボタンは押せるまま', () => {
  const all = draw(base(), ui({ cur: 'd4' }))
  assert.match(all, /data-id="d4"[^>]*>[^]*?<span class="tag lack">判断材料不足<\/span>/)
  noMatch(all.match(/data-id="d1"[^]*?<\/button>/)![0], /情報が足りません/)
  const html = detailOf(all)
  assert.match(html, /<div class="lackbox">判断材料が足りません（無い欄: 現状・対応案・懸念点）<\/div>/)
  assert.match(html, /<div class="h">概要<\/div>[^]*<div class="h">効果<\/div>/) // 書いてある欄は出す
  assert.ok(html.search(/class="lackbox"/) < html.search(/>選択肢</))
  const picked = detailOf(draw(base(), ui({ cur: 'd4', pick: { 'd4@1': 'own' } })))
  assert.match(picked, /<button class="btn pri" data-decide title=[^>]*>この案で決める<\/button>/)
})

test('決めるための情報の欄は閉じられ、閉じても描き直しで開かない', () => {
  const html = detailOf(draw(base(), ui({ cur: 'd1', ctxShut: { d1: true } })))
  assert.match(html, /data-ctx="d1" aria-expanded="false"/)
  noMatch(html, />概要</)
})

test('決には「情報が足りない」を出し、今の版に押してあれば「頼み済み」に替える。版が上がれば戻る', () => {
  const html = detailOf(draw(base(), ui({ cur: 'd1' })))
  assert.match(html, /<div class="acts">[^]*data-talk="d1"[^]*<button class="btn" data-needctx="d1"[^>]*>判断材料を求める<\/button>/)
  noMatch(detailOf(draw(base(), ui({ cur: 'v1' }))), /data-needctx/) // 決だけ
  const asked = (rev: number) => {
    const v = base()
    v.log.ops.push({ op_id: 90, at: '2026-11-16T10:00:00+09:00', item_id: 'd1', item_rev: rev, type: 'need_context', text: '既存の 18 社はどうなる？' })
    return detailOf(draw(v, ui({ cur: 'd1' })))
  }
  assert.match(asked(1), /<span class="tag">判断材料を依頼済み<\/span>/)
  noMatch(asked(1), /data-needctx/)
  assert.match(asked(0), /data-needctx="d1"/) // 古い版に押したもの
})

test('どの種類の項目にも「別の答えで決める」の欄を出し、質問（話したい）とは見出しで分ける。片付け済みには出さない', () => {
  for (const id of ['d1', 'v1', 'd2', 'a2']) {
    const html = detailOf(draw(base(), ui({ cur: id })))
    const head = id === 'd1' ? '選択肢以外で決める<span class="mut">　選択肢に無い答えや、もう済んだことを書いて送る</span>' : '別の返事を書く<span class="mut">　ほかの返事や、もう済んだことを書いて送る</span>'
    assert.match(html, new RegExp(`<div class="h">${head}</div>[^]*<textarea data-otherbox="${id}" rows="1" placeholder="例: もう手で送った／A 案で、ただし期限は金曜"[^]*<button class="btn sm" data-other="${id}" disabled>この答えで送る</button>`), id)
  }
  const d1 = detailOf(draw(base(), ui({ cur: 'd1', chat: 'd1', otherDraft: { d1: '自動で、ただし主任は外す' } })))
  assert.ok(d1.search(/>選択肢</) < d1.search(/>選択肢以外で決める</))
  assert.match(d1, /data-otherbox="d1"[^>]*>自動で、ただし主任は外す<\/textarea><button class="btn sm" data-other="d1">/) // 書きかけは描き直しで消えない
  assert.match(d1, /<div class="h">質問・相談<span class="mut">　決める前に聞く。/)
  noMatch(draw(base(), ui({ tab: 'arch', curArch: 'x2' })), /data-otherbox/)
})

test('別の答えは、反映待ちのあいだ「送った答え」、反映後は「あなたの答え」で片付け済みに残る', () => {
  const ops = [{ op_id: 1, at: '2026-11-16T10:00:00+09:00', item_id: 'd5', item_rev: 1, type: 'decide' as const, option_id: 'other', text: 'もう手で送った' }]
  assert.match(draw(base({ log: { ops } }), ui({ tab: 'arch', curArch: 'd5' })), /送った答え: もう手で送った（メインが反映待ち）/)
  const v = base()
  const d5 = v.cockpit!.items.find((i) => i.id === 'd5')!
  Object.assign(d5, { state: 'done', resolved_by: 'user', resolved_option: 'other', resolved_text: 'もう手で送った', resolved_at: '2026-11-16T10:05:00+09:00' })
  assert.match(draw(v, ui({ tab: 'arch', curArch: 'd5' })), /あなたの答え: もう手で送った/)
})

test('取り消して反映待ちの項目の札は「取り消し・反映待ち」', () => {
  const v = base()
  v.log.ops.push({ op_id: 1, at: '2026-11-16T10:00:00+09:00', item_id: 'd1', item_rev: 1, type: 'decide', option_id: 'auto' }, { op_id: 2, at: '2026-11-16T10:01:00+09:00', item_id: 'd1', item_rev: 1, type: 'undo', undo_of: 1 })
  assert.match(draw(v, ui()), /data-id="d1"[^]*?<span class="tag">取り消し・反映待ち<\/span>/)
})

test('背景・比較・図のどれも無い判断には、詳細へ飛ぶボタンを出さない', () => {
  const html = detailOf(draw(base(), ui({ cur: 'd4' })))
  assert.match(html, /data-more="d4"/) // この判断で変わること・タスクは詳細の欄にある
  noMatch(html, /data-jump/)
  assert.match(detailOf(draw(base(), ui({ cur: 'd3' }))), /data-jump="d3">比較を開く/)
})

test('見て: 依頼の原文 → 見てほしい点 → 開くボタン（PR の差分も）→ これでよい・直してほしい', () => {
  const html = detailOf(draw(base(), ui({ cur: 'v1' })))
  const at = (re: RegExp) => html.search(re)
  noMatch(detailOf(html), /class="crumb"/)
  assert.ok(at(/class="ask1"><span class="mut">依頼<\/span>「定例の前に、一覧画面の案と通知の下書きを一度見せてほしい」/) < at(/>確認の観点</))
  assert.match(html, /<ol class="look"><li>担当者の列が 1 画面目に入っているか<\/li><li>未対応の件数が上に出ているか<\/li><li>11\/14 定例の要望/)
  assert.ok(at(/>確認の観点</) < at(/data-href="docs\/design\/一覧画面.md:12"/))
  assert.match(html, /<button class="btn open" data-href="docs\/design\/一覧画面.md:12"[^>]*><span class="lk">ファイル<\/span><span class="">一覧画面の案を開く<\/span><\/button><button class="lnk" data-href="https:\/\/github.com\/example\/inquiry\/pull\/40"[^>]*><span class="lk">PR<\/span><span class="">差分<\/span>/)
  assert.match(html, /バージョン 2/)
  assert.ok(at(/data-href="docs/) < at(/data-accept>これでよい<\/button><button class="btn" data-fix>直してほしい/))
  noMatch(html, /差し替え済み/)
  assert.match(html, /data-fix>直してほしい<\/button><button class="btn" data-talk="v1"/)
})

test('見て: 成果物が差し替わって版が合わないときは知らせる。Drive の成果物は Drive の印', () => {
  const c = sample()
  c.requests![0]!.deliverables![0]!.version = 3
  assert.match(detailOf(draw(base({ cockpit: c }), ui({ cur: 'v1' }))), /差し替え済み・メインの更新待ち/)
  assert.match(detailOf(draw(base(), ui({ cur: 'v2' }))), /data-href="https:\/\/docs.google.com\/document\/d\/1AbCdEf\/edit"[^>]*><span class="lk">Drive<\/span>/)
})

test('話したい: 押すとその項目の下に入力欄が開き、やり取りを吹き出しで積む（利用者・アシスタント・メイン）', () => {
  assert.match(detailOf(draw(base(), ui({ cur: 'd1' }))), /<button class="btn" data-talk="d1" aria-expanded="false">質問する<\/button>/)
  noMatch(detailOf(draw(base(), ui({ cur: 'd1' }))), /data-chatbox/)
  const open = detailOf(draw(base(), ui({ cur: 'd1', chat: 'd1', chatDraft: { d1: '偏りは？' } })))
  assert.match(open, /<textarea data-chatbox="d1"[^>]*>偏りは？<\/textarea>[^]*data-send="d1">送る<\/button>/)
  assert.match(open, /<span class="count" data-count="chat:d1">残り 3996 字<\/span>/)
  assert.ok(open.search(/data-chatbox/) < open.search(/<div class="acts">/), '入力欄は返答のボタンの上')
  const ops = [
    { op_id: 1, at: '2026-11-16T11:00:00+09:00', item_id: 'd1', item_rev: 1, type: 'talk' as const, text: '自動だと偏らない？\n- 新人に寄らないか' },
    { op_id: 2, at: '2026-11-16T11:05:00+09:00', item_id: 'd1', item_rev: 1, type: 'talk' as const, text: '件数の上限は？' }
  ]
  const replies = [
    { op_id: 1, at: '2026-11-16T11:00:30+09:00', by: 'assistant' as const, text: '件数で均等に割るので偏りません。\n- 新人の上限は設定で決められます', handoff: true },
    { op_id: 1, at: '2026-11-16T11:30:00+09:00', by: 'main' as const, text: '上限を 5 件にした案を出し直します' }
  ]
  const html = detailOf(draw(base({ log: { ops }, replies, thinking: [2] }), ui({ cur: 'd1' })))
  assert.match(html, /<div class="msg me"><div class="who">あなた<span class="mut num">11\/16 11:00<\/span><\/div><div class="txt"><div class="rt-box"><p class="rtp">自動だと偏らない？<\/p><ul class="rt"><li>新人に寄らないか/)
  assert.match(html, /<div class="msg ai"><div class="who">すぐの回答<span class="mut">（読むだけ・作業はしない）<\/span>[^]*件数で均等に割るので[^]*data-handoff="d1" data-of="1">メインに渡す<\/button><span class="mut">押すと同じ質問をメインに回し/)
  assert.match(html, /<div class="msg main"><div class="who">メイン<span class="mut">（作業と操縦席の更新もする）<\/span>[^]*上限を 5 件にした案/)
  assert.match(html, /件数の上限は？[^]*関係するファイルを読んでいます…/)
  noMatch(detailOf(draw(base({ log: { ops }, replies }), ui({ cur: 'd3' }))), /msg me/)
})

test('メインに渡したあとは「メインに渡す」のボタンを消し、引き継ぎへのメインの回答をその下に出す。回答できなかったときは知らせる', () => {
  const ops = [
    { op_id: 1, at: '2026-11-16T11:00:00+09:00', item_id: 'd1', item_rev: 1, type: 'talk' as const, text: '割り当てを変えて' },
    { op_id: 2, at: '2026-11-16T11:01:00+09:00', item_id: 'd1', item_rev: 1, type: 'talk' as const, to_main: true, handoff_of: 1, text: '割り当てを変えて' }
  ]
  const replies = [
    { op_id: 1, at: '2026-11-16T11:00:30+09:00', by: 'assistant' as const, text: '変更はメインが行います', handoff: true },
    { op_id: 2, at: '2026-11-16T11:20:00+09:00', by: 'main' as const, text: '手で取る案に変えて出し直しました' }
  ]
  const html = detailOf(draw(base({ log: { ops }, replies }), ui({ cur: 'd1' })))
  noMatch(html, /data-handoff/)
  assert.equal(html.match(/割り当てを変えて/g)?.length, 1, '引き継ぎで元の発言を繰り返さない')
  assert.match(html, /メインに渡しました。メインが次に読みます<\/div><div class="msg main">[^]*手で取る案に変えて出し直しました/)
  // 本文の無い古い引き継ぎも、その回答を出す
  const old = [ops[0]!, { op_id: 2, at: '2026-11-16T11:01:00+09:00', item_id: 'd1', item_rev: 1, type: 'talk' as const, to_main: true }]
  const oldHtml = detailOf(draw(base({ log: { ops: old }, replies }), ui({ cur: 'd1' })))
  noMatch(oldHtml, /data-handoff/)
  assert.match(oldHtml, /メインに渡しました[^]*手で取る案に変えて出し直しました/)
  const failed = [{ op_id: 1, at: '2026-11-16T11:00:30+09:00', by: 'assistant' as const, text: '回答できませんでした。メインが次に読みます', failed: true }]
  assert.match(detailOf(draw(base({ log: { ops: [ops[0]!] }, replies: failed }), ui({ cur: 'd1' }))), /<div class="msg ai failed">[^]*回答できませんでした/)
  assert.match(detailOf(draw(base({ log: { ops: [ops[0]!] } }), ui({ cur: 'd1' }))), /回答待ち（窓の常駐のプロセスが答えます/)
})

test('直してほしい: 入力欄を開いて書き出しを入れ、送るとメインに渡す。タスクにも話したいがある', () => {
  const html = detailOf(draw(base(), ui({ cur: 'v1', chat: 'v1', fix: 'v1', chatDraft: { v1: '【操縦席】r1 / 一覧画面の案 を直したい: ' } })))
  assert.match(html, /どこを直すかを書いて送ってください。[^]*>【操縦席】r1 \/ 一覧画面の案 を直したい: <\/textarea>[^]*data-send="v1">メインに送る<\/button>/)
  const t = detailOf(draw(base(), ui({ tab: 'whole', curTask: 't5' })))
  assert.match(t, /data-talk="t5">質問する<\/button>/)
  const ops = [{ op_id: 1, at: '2026-11-16T11:00:00+09:00', item_id: 't5', item_rev: 0, type: 'talk' as const, text: 'CI は何分かかる？' }]
  assert.match(detailOf(draw(base({ log: { ops } }), ui({ tab: 'whole', curTask: 't5' }))), /質問・相談[^]*CI は何分かかる？/)
})

test('質問の書きかけは項目ごとに持ち、別の項目の入力欄に出さない', () => {
  const html = detailOf(draw(base(), ui({ cur: 'd3', chat: 'd3', chatDraft: { d1: 'd1 で書きかけた質問' } })))
  assert.match(html, /<textarea data-chatbox="d3"[^>]*><\/textarea>/)
  noMatch(html, /d1 で書きかけた質問/)
  assert.match(html, /data-send="d3" disabled>/)
})

test('上限を超えた書きかけは切らずに残し、超えた字数を出して送るボタンを止める', () => {
  const long = 'あ'.repeat(4001)
  const html = detailOf(draw(base(), ui({ cur: 'd1', otherDraft: { d1: long }, chat: 'd1', chatDraft: { d1: long } })))
  assert.ok(html.includes(`>${long}</textarea>`))
  assert.match(html, /data-other="d1" disabled>この答えで送る/)
  assert.match(html, /data-send="d1" disabled>送る/)
  assert.match(html, /<span class="count over-limit" data-count="other:d1">4001 \/ 4000 字。1 字多いので送れません<\/span>/)
  assert.match(detailOf(draw(base(), ui({ cur: 'd1', otherDraft: { d1: 'あ'.repeat(4000) } }))), /data-other="d1">この答えで送る[^]*残り 0 字/)
})

test('リンクの種類はドメインから決め、http(s) 以外の URL は押せる形にしない', () => {
  assert.equal(linkKind('https://drive.google.com/file/d/x/view'), 'Drive')
  assert.equal(linkKind('https://docs.google.com/spreadsheets/d/x'), 'Drive')
  assert.equal(linkKind('https://github.com/o/r/pull/12'), 'PR')
  assert.equal(linkKind('https://github.com/o/r/blob/main/a.md'), 'ページ')
  assert.equal(linkKind('https://claude.ai/artifact/abc'), 'ページ')
  assert.equal(linkKind('docs/設計/画面.md:30'), 'ファイル')
  assert.equal(linkKind('/Users/me/orca/workspaces/x/a-w1/out.md'), 'ファイル')
  noMatch(linkHtml('javascript:alert(1)'), /data-href/)
  noMatch(linkHtml('file:///etc/passwd'), /data-href/)
  // 同じ形の URL が並んでも見分けられるよう、PR は番号、スプレッドシートは行で名前を付ける
  assert.match(linkHtml('https://github.com/example/ticket-app/pull/42'), /<span class="lk">PR<\/span><span class="">ticket-app #42<\/span>/)
  assert.match(linkHtml('https://docs.google.com/spreadsheets/d/1XI4/edit#gid=0&range=A94'), /<span class="">スプレッドシート A94 行<\/span>/)
  assert.match(linkHtml('docs/設計/画面.md'), /data-href="docs\/設計\/画面.md"[^>]*><span class="lk">ファイル<\/span><span class="mono">設計\/画面.md<\/span>/)
})

test('報告に成果物のリンクがあれば開くボタンを出す', () => {
  const html = detailOf(draw(base(), ui({ cur: 'a3' })))
  assert.match(html, /PR ごとに Postgres を立てて[^]*data-href="https:\/\/github.com\/example\/inquiry\/pull\/41"[^>]*><span class="lk">PR<\/span><span class="">成果物を開く/)
  assert.match(html, /data-ack>確認した/)
})

test('全体: 大タスクを手当ての要る順のまとまりで並べ、横にまだ済んでいない依頼（古い順・状態つき）', () => {
  const html = draw(base(), ui({ tab: 'whole' }))
  const at = (re: RegExp) => html.search(re)
  assert.match(html, /まだ済んでいない依頼 <span class="num">2<\/span> 件/)
  assert.ok(at(/data-req="r2"/) < at(/data-req="r1"/), '古い依頼が上')
  assert.match(html, /data-req="r1"[^>]*>一覧画面と通知の案を見たい<\/button><span class="rs rs-review">確認待ち<\/span>/)
  assert.match(html, /data-req="r2"[^>]*>テストを本番と同じ DB で回したい<\/button><span class="rs rs-working">作業中<\/span>/)
  noMatch(html, /data-req="r0"/)
  assert.ok(at(/class="ovmain"/) < at(/まだ済んでいない依頼/), '大タスクが主、依頼は横の列')
  // まとまりは 要対応あり → 止まっている → 外部待ち → 進行中 → 未着手 → 完了 の順で、各大タスクは 1 か所だけに出る
  const order = [...html.matchAll(/<section class="ovsec ov-(\w+)">/g)].map((m) => m[1])
  const RANK = ['yours', 'stop', 'wait', 'run', 'idle', 'ok']
  assert.deepEqual(order, [...order].sort((a, b) => RANK.indexOf(a!) - RANK.indexOf(b!)))
  for (const id of ['s1', 's2', 's3', 's5']) assert.equal((html.match(new RegExp(`class="ovr" data-stream="${id}"`, 'g')) ?? []).length, 1, id)
  // 行の要対応の件数の合計は、上の帯の件数と同じ（確認は一覧に並ぶ大タスクだけで数える）
  const sum = [...html.matchAll(/<b>要対応 <span class="num">(\d+)<\/span> 件<\/b>/g)].reduce((n, m) => n + Number(m[1]), 0)
  assert.equal(sum, 7)
  // 全タスク完了で開いた確認の無い「全体の設計」だけを畳む
  assert.match(html, /data-done="#streams" aria-expanded="false">[^]*完了 <span class="num">1<\/span> 件/)
  noMatch(html, /data-stream="s4"/)
  assert.match(draw(base(), ui({ tab: 'whole', showDone: { '#streams': true } })), /data-stream="s4">[^]*全体の設計/)
})

test('全体の行: 状態・名前・工程の進み（何段目か）・要対応と、この大タスクに並ぶいちばん急ぐ確認か今の様子と次の作業を出す', () => {
  const html = draw(base({ cockpit: harness() }), ui({ tab: 'whole' }))
  // 工程は手を付けたタスクのいちばん先（実装）。調査は済んだ工程として塗る
  assert.match(html, /data-stream="x">[^]*X からハーネスへの取り込み[^]*<span class="ovt"><b>要対応 <span class="num">1<\/span> 件<\/b>[^]*<span class="ovsub"><span class="ovnow">あなたの判断待ち「[^」]+」<\/span><span class="pbar"[^>]*><span class="pps" aria-hidden="true"><i class="pp on" title="調査"><\/i><i class="pp cur" title="実装"><\/i><\/span><span class="ppn">工程 <span class="num">2\/2<\/span> 実装<\/span>/)
  // 全体の行の 1 行は、この大タスクに並ぶ確認を引く（ほかの大タスクの確認を引かない）
})

test('外部待ちは相手・待ち始めた日・次の作業を 1 行で出す。日付は waiting_since、無ければ顧客に聞いた日', () => {
  const c = sample()
  const t6 = c.tasks.find((t) => t.id === 't6')!
  Object.assign(t6, { state: 'wait', waiting_on: '佐藤さん（認証情報）', waiting_since: '2026-11-17', next: '届いたら、検証環境へ入れる日程を確定する' })
  c.items = c.items.map((i) => ({ ...i, related: (i.related ?? []).filter((r) => r.task !== 't6') }))
  const page = draw(base({ cockpit: c }), ui({ tab: 'whole', curStream: t6.stream }))
  assert.match(page, /佐藤さん（認証情報）の返事待ち（11\/17\(火\) から）。次: 届いたら、検証環境へ入れる日程を確定する/)
  // 経過に「外部待ちになった」が日付つきで並び、今と次で締める
  assert.match(page, /<span class="tld num">11\/17\(火\)<\/span><span class="tlk">外部待ち<\/span>[^]*class="tle now"[^]*class="tle next"[^]*届いたら、検証環境へ入れる日程を確定する/)
  delete t6.waiting_since
  noMatch(draw(base({ cockpit: c }), ui({ tab: 'whole', curStream: t6.stream })), /の返事待ち（[^）]*から）/)
})

test('依頼を開くと、原文・タスクと worker・成果物とその確認の状態が見える', () => {
  const workers: AgentRow[] = [{ terminalId: 'w1', title: 'notify-draft', job: '通知の設計', task: 't2', agent: 'claude', state: 'working', since: NOW - 60000 }]
  const html = detailOf(draw(base({ workers }), ui({ tab: 'whole', curReq: 'r1' })))
  assert.match(html, /<span class="kind k-req">依頼<\/span>[^]*確認待ち[^]*<h2>一覧画面と通知の案を見たい<\/h2><blockquote class="orig">定例の前に/)
  assert.match(html, /data-task="t2">通知の設計<\/button>[^]*worker 作業中<button class="link" data-agent="w1"/)
  assert.match(html, /一覧画面の案<\/span><\/button>[^]*バージョン 2[^]*data-goto="v1">確認（要対応）/)
  const r2 = detailOf(draw(base(), ui({ tab: 'whole', curReq: 'r2' })))
  assert.match(r2, /CI の変更<\/span><\/button><span class="mut">報告のみ<\/span>/)
})

test('タスクの詳細: 記録された worker の状態、出どころのリンク（日本語のファイル名・Drive・行）、依頼', () => {
  const workers: AgentRow[] = [{ terminalId: 'w2', title: 'ci-setup', job: 'テスト用 DB の用意', task: 't5', agent: 'claude', state: 'blocked', since: NOW - 25 * 60000, stop: 'blocked', worktree: '/w/a-w2' }]
  const worktrees = ['r::a', 'r::a1', 'r::a2']
  const t5 = detailOf(draw(base({ workers, worktrees }), ui({ tab: 'whole', curTask: 't5' })))
  assert.match(t5, />worker<\/div><span class="chip bad ">[^]*テスト用 DB の用意[^]*許可待ち/)
  assert.match(t5, />依頼<\/div>[^]*data-req="r2"/)
  assert.match(detailOf(draw(base({ worktrees }), ui({ tab: 'whole', curTask: 't2' }))), />worker<\/div><span class="mut">作業を終えています。メインの取り込み待ち/)
  // パネルは worktree の一覧を持たず worker とタスクを結べないので、worker の欄を出さない
  noMatch(detailOf(draw(base(), ui({ tab: 'whole', curTask: 't2' }))), />worker<\/div>/)
  const t1 = detailOf(draw(base({ figures: { '.orca/cockpit/figures/list-wire.svg': '<svg viewBox="0 0 10 10"></svg>' } }), ui({ tab: 'whole', curTask: 't1' })))
  assert.match(t1, /出典 <button class="lnk" data-href="docs\/design\/一覧画面.md"[^]*<span class="lk">Drive<\/span>[^]*data-href="project\/minutes\/2026-11-14.md:42"/)
  assert.ok(t1.search(/出典/) > 0 && t1.search(/出典/) < t1.search(/関係する判断/))
  assert.ok(t1.search(/現在の案/) > 0 && t1.search(/現在の案/) < t1.search(/関係する判断/))
  noMatch(t1, /元の記録/)
})

test('worker のタスクは、同じ cockpit.json と Orca の状態から、表のマス・一覧の行・詳しい欄で同じ状態を出す', () => {
  const c = sample()
  c.streams = [{ id: 'x', title: '取り込み' }]
  c.phases = ['実装']
  // 済んだ t1 と進行中の t25 が同じ worktree の worker（2026-11-16 に、済んだ t1 に結んで t25 が「動いていません」と出た）
  c.tasks = [
    { id: 't1', stream: 'x', phase: '実装', title: '最初の取り込み', state: 'ok', worker: { worktree_id: 'r::w' } },
    { id: 't25', stream: 'x', phase: '実装', title: '窓の直し', state: 'run', worker: { worktree_id: 'r::w', terminal: 'term_w' } }
  ]
  // 確認が並ぶと全体の行はその確認を出すので、タスクの状態だけを比べられるよう、この大タスクに入る確認（依頼 r1 経由の見て）を外す
  c.items = c.items.filter((i) => i.kind !== 'rev').map((i) => ({ ...i, related: [] }))
  const agent = (o: Partial<AgentRow>): AgentRow => ({ terminalId: 'term_w', title: 'w', agent: 'claude', state: 'working', since: NOW - 60000, worktree: '/w/w', task: 't25', ...o })
  // 全体の大タスクの行の様子・大タスクの画面のタスクの行・タスクの詳細の見出し
  const three = (workers: AgentRow[], worktrees: string[]) => {
    const v = base({ cockpit: c, workers, worktrees })
    const cell = /data-stream="x">[^]*?<span class="ovnow">([^<]*)<\/span>/.exec(draw(v, ui({ tab: 'whole' })))![1]
    const row = /data-task="t25">[^]*?<span class="ts [^"]*">([^<]*)<\/span>/.exec(draw(v, ui({ tab: 'whole', curStream: 'x' })))![1]
    const head = /<h2>窓の直し <span class="stb">[^]*?<span class="[^"]*">([^<]*)<\/span><\/span><\/h2>/.exec(detailOf(draw(v, ui({ tab: 'whole', curTask: 't25' }))))![1]
    return [cell, row, head]
  }
  assert.deepEqual(three([agent({})], ['r::a', 'r::w']), ['進行中（worker が作業中）', '進行中（worker が作業中）', '進行中（worker が作業中）'])
  assert.deepEqual(three([agent({ state: 'done' })], ['r::a', 'r::w']), ['メインの取り込み待ち', 'メインの取り込み待ち', 'メインの取り込み待ち'])
  assert.deepEqual(three([], ['r::a']), ['worker が見つかりません（メインの記録漏れ）', 'worker が見つかりません（メインの記録漏れ）', 'worker が見つかりません（メインの記録漏れ）'])
  assert.deepEqual(three([agent({ state: 'blocked', stop: 'blocked' })], ['r::a', 'r::w']), ['worker が許可待ち', 'worker が許可待ち', 'worker が許可待ち'])
  // 進行中のタスクの詳しい欄に「動いていません」を出さない
  noMatch(detailOf(draw(base({ cockpit: c, workers: [agent({})], worktrees: ['r::a', 'r::w'] }), ui({ tab: 'whole', curTask: 't25' }))), /動いていません/)
})

test('全体では、タスクの担当・依頼の内部の id を出さない', () => {
  const t1 = draw(base(), ui({ tab: 'whole', curTask: 't1' }))
  noMatch(t1, /class="ph"|担当 メイン/)
  assert.match(detailOf(t1), />次の作業<\/div>担当者の列を置くかを決め/)
  const r1 = detailOf(draw(base(), ui({ tab: 'whole', curReq: 'r1' })))
  assert.match(r1, /<span class="kind k-req">依頼<\/span><span class="num">11\/14\(土\) 18:10<\/span>/)
  noMatch(r1, /\br1\b/)
})

test('片付け済み: 大タスクごとに新しい順で並び、行に日時を出し、選んだ項目を読み取り専用で出す。完了した依頼も並ぶ', () => {
  const html = draw(base(), ui({ tab: 'arch', curArch: 'x2' }))
  assert.match(html, /今日.*昨日/s)
  assert.match(html, /あなたが決定「Entra ID」/)
  assert.match(html, /採用/)
  noMatch(html, /data-decide/)
  assert.match(html, /data-areq="r0"[^]*認証方式の比較表/)
  assert.match(html, /<section class="sgrp"><button class="shead" data-stream=/)
  const r0 = detailOf(draw(base(), ui({ tab: 'arch', curArch: 'req:r0' })))
  assert.match(r0, /<h2>認証方式の比較表<\/h2>[^]*完了 11\/15\(日\) 18:00/)
})

test('片付け済みは日時の値で新しい順（タイムゾーンの書き方が違っても）', () => {
  const ops = [{ op_id: 1, at: '2026-11-16T03:49:00Z', item_id: 'd1', item_rev: 1, type: 'decide' as const, option_id: 'auto' }]
  const html = draw(base({ log: { ops } }), ui({ tab: 'arch' }))
  assert.ok(html.indexOf('担当者の割り当て方を決める') < html.indexOf('worker notify-draft'))
  assert.match(html, /あなたが決定「システムが自動で割り当てる」・反映待ち/)
})

test('承認した見ては片付け済みに「あなたが承認」で入る', () => {
  const ops = [{ op_id: 1, at: '2026-11-16T11:59:00+09:00', item_id: 'v1', item_rev: 2, type: 'accept' as const }]
  const html = draw(base({ log: { ops } }))
  assert.match(html, /要対応 <b class="num">6<\/b> 件/)
  assert.match(draw(base({ log: { ops } }), ui({ tab: 'arch', curArch: 'v1' })), /あなたが承認・反映待ち/)
})

test('エージェントが決めたことの各行に「戻して」を出し、押した行は反映待ちにする', () => {
  const u = ui({ cur: 'a2' })
  assert.equal((draw(base(), u).match(/data-revert=/g) ?? []).length, 3)
  const ops = [{ op_id: 1, at: '2026-11-16T11:59:59+09:00', item_id: 'a2', item_rev: 1, type: 'revert' as const, target: 1 }]
  const html = draw(base({ log: { ops } }), u)
  assert.equal((html.match(/data-revert=/g) ?? []).length, 2)
  assert.match(html, /戻す依頼・反映待ち/)
  assert.match(html, /エージェントが決めたこと 3 件/)

  const c = sample()
  c.items.find((i) => i.id === 'a2')!.rev = 2
  assert.equal((draw(base({ cockpit: c, log: { ops } }), u).match(/data-revert=/g) ?? []).length, 3)
})

test('ファイルの文字列は HTML として解釈しない', () => {
  const c = sample()
  c.items[0]!.title = '<img src=x onerror=alert(1)>'
  c.requests![0]!.deliverables![0]!.href = '"><img src=x onerror=alert(1)>'
  noMatch(draw(base({ cockpit: c })), /<img src=x/)
  noMatch(draw(base({ cockpit: c }), ui({ cur: 'v1' })), /<img src=x/)
})

test('壊れたファイルのエラーは 1 行で出し、前回の表示を保つ', () => {
  const html = draw(base({ errors: ['cockpit.json を読めません（前回の表示のまま）: x'] }))
  assert.match(html, /cockpit.json を読めません/)
  assert.match(html, /担当者の割り当て方を決める/)
})

test('どのタスクにもつながらない判断とタスクに「つながりなし」を出す', () => {
  const c = sample()
  c.items = c.items.map((i) => (i.id === 'd1' ? { ...i, related: [] } : i))
  c.tasks.push({ id: 'lost', stream: 'nowhere', phase: '設計', title: '迷子のタスク', state: 'run' })
  assert.match(draw(base({ cockpit: c }), ui({ cur: 'd1' })), /担当者の割り当て方を決める<\/span> <span class="tag loose"[^]*<div class="sec"><span class="tag loose"/)
  // どの大タスクにも入らないタスクは、全体の「大タスクにつながらないタスク」の行と、その画面に出る
  const table = draw(base({ cockpit: c }), ui({ tab: 'whole' }))
  assert.match(table, /data-stream="#loose">[^]*大タスクにつながらないタスク/)
  assert.ok(table.search(/data-stream="#loose"/) > table.search(/data-stream="s3"/))
  assert.match(draw(base({ cockpit: c }), ui({ tab: 'whole', curStream: '#loose' })), /data-task="lost">[^]*<span class="t">迷子のタスク<\/span>/)
})

test('合図: 取り消しの猶予が過ぎた操作は自動で送るので、ボタンは送れなかったときだけ出す', () => {
  const ops = [{ op_id: 1, at: '2026-11-16T11:59:00+09:00', item_id: 'd1', item_rev: 1, type: 'decide' as const, option_id: 'auto' }]
  noMatch(draw(base({ log: { ops } })), /data-notify/)
  assert.match(draw(base({ log: { ops }, notifiedOp: 1 })), /メインに届けました（反映待ち 1 件）/)
  assert.match(draw(base({ log: { ops }, signal: { state: 'waiting' } })), /メインの作業が一区切りしたら届けます/)
  const failed = draw(base({ log: { ops }, signal: { state: 'failed', reason: 'メインの端末が見つかりません' } }))
  assert.match(failed, /メインに届いていません: メインの端末が見つかりません.*data-notify>もう一度送る/s)
})

test('メインがチャット（main.terminal が空）なら、合図のボタンを出さずに次に話しかけたとき反映されると出す', () => {
  const c = sample()
  c.main = { agent: 'claude', terminal: '' }
  const log = { ops: [{ op_id: 1, at: '2026-11-16T11:00:00+09:00', item_id: 'd1', item_rev: 1, type: 'talk' as const }] }
  const html = draw(base({ cockpit: c, log, signal: { state: 'failed', reason: 'x' } }))
  assert.match(html, /メインはチャットのため、次に話しかけたときに反映されます/)
  noMatch(html, /data-notify/)
})

test('止まった worker は仕事の名前・理由・時間と「端末を開く」で出す', () => {
  const workers = [
    { terminalId: 'a', title: 'notify-draft', agent: 'claude', state: 'working' as const, since: NOW - 60000 },
    { terminalId: 'b', title: 'fix-no92', job: '抽選の修正', agent: 'claude', state: 'done' as const, since: NOW - 3 * 3600000, stop: 'limit' as const, worktree: '/w/b' }
  ]
  const html = draw(base({ workers }))
  assert.match(html, /<span class="job">抽選の修正<\/span><b>利用枠切れ<\/b><span class="num">3時間<\/span><button class="link" data-agent="b" data-wt="\/w\/b">端末を開く<\/button>/)
  noMatch(html, /fix-no92|notify-draft/)
  noMatch(html, /操縦席の更新が/)
})

test('全体: 聞き方を承認しただけの問いは確認予定、実際に聞いた（asked_at）ものだけ回答待ちと出す', () => {
  const c = sample()
  const ask = c.items.find((i) => i.kind === 'ask')!
  ask.state = 'done'
  ask.resolved_by = 'user'
  ask.resolved_at = '2026-11-14T10:00:00+09:00'
  const html = draw(base({ cockpit: c }), ui({ tab: 'whole' }))
  assert.match(html, /顧客への確認 <span class="num">1<\/span> 件.*回答待ち 0 件・確認予定 1 件.*data-goarch="[^"]+">過去の問い合わせ.*確認予定.*聞き方を承認 11\/14\(土\).*聞く 11\/21\(土\) 定例/s)
  noMatch(html, /回答待ち（/)
  ask.asked_at = '2026-11-21T10:00:00+09:00'
  const asked = draw(base({ cockpit: c }), ui({ tab: 'whole' }))
  assert.match(asked, /回答待ち 1 件・確認予定 0 件.*回答待ち（<span class="num">11\/21\(土\)<\/span> から）/s)
})

test('外に送る文面は、宛先と改行を保った本文を選択肢の前に出し、コピーと下書きを開くボタンを付ける', () => {
  const html = detailOf(draw(base(), ui({ cur: 'd5' })))
  const at = (re: RegExp) => html.search(re)
  assert.match(html, /<div class="h">送る文面<\/div><div class="dbox"><div class="dto"><span class="mut">宛先<\/span>田中さん（Slack・問い合わせ管理の共有チャンネル）<\/div><div class="dtext">田中さん\nお疲れさまです。佐藤です。\n\n11\/21 の定例の前に/)
  assert.match(html, /data-copydraft="d5">本文をコピー<\/button><button class="lnk" data-href="https:\/\/example.slack.com\/archives\/C0123\/p1731740000"[^>]*><span class="lk">ページ<\/span><span class="">下書きを開く/)
  assert.ok(at(/送る文面/) < at(/>選択肢</))
  assert.ok(at(/>選択肢</) < at(/<div class="links">/))
  assert.ok(at(/<div class="links">/) < at(/data-more="d5"/))
  assert.match(html, /<div class="links"><button class="lnk" data-href="https:\/\/github.com\/example\/inquiry\/pull\/40"[^>]*><span class="lk">PR<\/span><span class="">一覧画面の案（PR）<\/span><\/button><button class="lnk" data-href="project\/minutes\/2026-11-14.md:42"/)
})

test('説明の文は、改行・箇条・番号付きの箇条で描き、URL と前置き付きの #番号 をリンクにする', () => {
  const html = detailOf(draw(base(), ui({ cur: 'a4' })))
  assert.match(html, /<p class="rtp">見る順番<\/p><ol class="rt"><li>単独でマージできる: BE <button class="ilnk" data-href="https:\/\/github.com\/example\/inquiry-be\/pull\/126"[^>]*>#126<\/button>・#135、FE <button class="ilnk" data-href="https:\/\/github.com\/example\/inquiry-fe\/pull\/57"/)
  assert.match(html, /<\/ol><ul class="rt"><li>積み上げの 3 本は[^]*<li>詳しい手順は <button class="ilnk" data-href="https:\/\/github.com\/example\/inquiry-be\/wiki\/review"/)
  assert.equal(richText('1 行だけ。#12 は repo が無いので文字のまま'), '1 行だけ。#12 は repo が無いので文字のまま')
  assert.match(richText('PR #12 を見る', 'o/r'), /PR <button class="ilnk" data-href="https:\/\/github.com\/o\/r\/pull\/12"/)
  assert.match(richText('# 見出し\n本文\n- a\n- b'), /<div class="rth">見出し<\/div><p class="rtp">本文<\/p><ul class="rt"><li>a<\/li><li>b<\/li><\/ul>/)
  noMatch(richText('<b>x</b>\n- <i>y</i>'), /<b>x|<i>/)
})

test('回答と長い文は Markdown として描き、HTML はエスケープし、開けないリンクは文字だけにする', () => {
  assert.equal(richText('**太字**と*斜体*と`npm test`'), '<strong>太字</strong>と<em>斜体</em>と<code>npm test</code>')
  assert.equal(richText('[設計](docs/design/一覧画面.md) と [PR](https://github.com/o/r/pull/1)'),
    '<button class="ilnk" data-href="docs/design/一覧画面.md" title="docs/design/一覧画面.md">設計</button> と <button class="ilnk" data-href="https://github.com/o/r/pull/1" title="https://github.com/o/r/pull/1">PR</button>')
  assert.equal(richText('[押して](javascript:alert)'), '押して')
  noMatch(richText('[押して](javascript:alert(1))\n- [x](data:text/html,1)'), /data-href|javascript|data:text/)
  assert.equal(richText('<script>alert(1)</script> **<img src=x>**'), '&lt;script&gt;alert(1)&lt;/script&gt; <strong>&lt;img src=x&gt;</strong>')
  assert.equal(
    richText('## 手順\n1. 取り込む\n  - **差分**を見る\n  - 戻す\n2. 確かめる\n> 利用者の発言\n> 2 行目\n```\nconst a = <b>1</b>\n```'),
    '<div class="rt-box"><div class="rth">手順</div><ol class="rt"><li>取り込む<ul class="rt"><li><strong>差分</strong>を見る</li><li>戻す</li></ul></li><li>確かめる</li></ol>' +
      '<blockquote class="rtq">利用者の発言<br>2 行目</blockquote><pre class="rtcode"><code>const a = &lt;b&gt;1&lt;/b&gt;</code></pre></div>'
  )
  // 掛け算や 1.5 倍は箇条・斜体にしない
  assert.equal(richText('5 * 3 * 2 は 30'), '5 * 3 * 2 は 30')
  assert.equal(richText('1.5 倍にする\n次の行'), '<div class="rt-box"><p class="rtp">1.5 倍にする</p><p class="rtp">次の行</p></div>')
})

test('次の節目は、今日以降を近い順に 3 件「日付・あと n 日・名前」で出し、残りは畳む。過ぎた節目は出さない', () => {
  const c = sample()
  c.workspace.milestones = [
    { date: '2026-12-12', label: '設計の合意' }, { date: '2026-11-10', label: '過ぎた定例' }, { date: '2026-11-16', label: '社内レビュー' },
    { date: '2026-11-18T10:00:00+09:00', label: 'PMO レビュー' }, { date: '2026-11-21', label: '定例' }, { date: '2027-01-23', label: '受入' }
  ]
  const ms = (u: Partial<Ui>) => /<h3 class="h">次の節目<\/h3>[^]*?<\/ul>(?:<button[^>]*>[^<]*<\/button>)?<\/section>/.exec(draw(base({ cockpit: c }), ui({ tab: 'whole', ...u })))![0]
  const rows = (h: string) => [...h.matchAll(/<li><span class="num">([^<]*)<\/span><span class="msd[^"]*">(.*?)<\/span><span>([^<]*)<\/span><\/li>/g)].map((m) => [m[1], m[2]!.replace(/<[^>]+>/g, ''), m[3]])
  const folded = ms({})
  assert.deepEqual(rows(folded), [['11/16(月)', '今日', '社内レビュー'], ['11/18(水)', 'あと 2 日', 'PMO レビュー'], ['11/21(土)', 'あと 5 日', '定例']])
  assert.match(folded, /<button class="more" data-ms aria-expanded="false">ほか 2 件<\/button>/)
  const open = ms({ showMs: true })
  assert.deepEqual(rows(open).map((r) => r[2]), ['社内レビュー', 'PMO レビュー', '定例', '設計の合意', '受入'])
  assert.match(open, /data-ms aria-expanded="true">畳む</)
  noMatch(draw(base({ cockpit: c }), ui({ tab: 'whole', showMs: true })), /過ぎた定例|<svg viewBox="0 0 600/)
  c.workspace.milestones = [{ date: '2026-11-01', label: '過ぎた' }]
  noMatch(draw(base({ cockpit: c }), ui({ tab: 'whole' })), /次の節目/)
})

test('図は詳細の欄の幅いっぱいに描き、字が 14px になる幅を拡大の目安として持たせる', () => {
  assert.equal(figureWidth('<svg viewBox="0 0 480 236" font-size="14"><text>a</text></svg>'), 480)
  assert.equal(figureWidth('<svg viewBox="0 0 640 300"><text font-size="9">a</text><text style="font-size:12px">b</text></svg>'), 996)
  assert.equal(figureWidth('<svg viewBox="0 0 640 300"><text>a</text></svg>'), undefined)
  const html = draw(base({ figures: { '.orca/cockpit/figures/list-wire.svg': '<svg viewBox="0 0 480 200" font-size="14"></svg>' } }), ui({ tab: 'whole', curTask: 't1' }))
  assert.match(html, /<div class="fig" data-w="480" style="max-width:480px"><svg/)
})

const wsRow = (over: Partial<WsRow>): WsRow => ({ root: '/x', name: 'x', open: 0, counts: { dec: 0, ask: 0, rev: 0 }, workers: 0, stopped: 0, ...over })

test('窓: 上の帯に全案件の合計と内訳、列は案件ごと。いちばん急ぐ 1 件・動いているエージェント・worker の総数は出さない。要対応なし案件は下に畳む', () => {
  const hot = wsRow({ root: '/a', name: '案件A', open: 3, counts: { dec: 2, ask: 0, rev: 1 }, due: '2026-11-15', next: { id: 'd1', title: '担当者を決める' }, workers: 3, stopped: 1 })
  const calm = (n: string) => wsRow({ root: `/${n}`, name: `案件${n}` })
  const w = { mode: 'manual' as const, focused: '/b', rows: [hot, calm('b'), calm('c')], live: 4, view: base({ root: '/a' }), errors: [] }
  const html = renderWindow(w, w.view, ui(), NOW, (s) => s)
  assert.match(html, /<span class="turn"><span class="tcount">要対応 <b class="num">3<\/b> 件<span class="brk">（判断 <span class="num">2<\/span> 件・確認 <span class="num">1<\/span> 件）<\/span><\/span><span class="stopn">.*止まっている worker <b class="num">1<\/b> 件/s)
  noMatch(html, /いちばん急ぐ|動いているエージェント|worker 計/)
  assert.match(html, /data-ws="\/a" aria-current="true"[^]*<span class="wdec">要対応 <b class="num">3<\/b> 件[^]*期限切れ[^]*止まっている worker <b class="num">1<\/b> 件/)
  assert.match(html, /data-idle aria-expanded="false">.*要対応なし <b class="num">2<\/b> 件/)
  noMatch(html, /data-ws="\/b"/)
  assert.match(renderWindow(w, w.view, ui({ showIdle: true }), NOW, (s) => s), /data-ws="\/b"[^]*案件b<\/b><span class="orca">Orca で表示中<\/span>/)
  assert.match(html, /固定中.*data-follow>Orca に合わせる.*data-activate/s)
  assert.match(renderWindow({ ...w, mode: 'follow' }, w.view, ui(), NOW, (s) => s), /Orca に合わせて表示/)
  assert.match(renderWindow({ ...w, rows: [calm('b')] }, w.view, ui(), NOW, (s) => s), /全案件 要対応なし/)
})

test('案件の名前・次の節目・要約・更新の時刻の帯は出さず、操縦席が worker より古くても知らせない。詳細の題名は読み上げにだけ残す', () => {
  const fresh = base({ workers: [{ terminalId: 'a', title: 'w', agent: 'claude', state: 'working', since: new Date('2026-11-16T11:00:00+09:00').getTime() }] })
  const html = draw(fresh, ui({ cur: 'd1' }))
  noMatch(html, /<h1>|次の節目|一覧画面の設計があなたの判断待ち。他は予定どおり|操縦席の更新/)
  assert.match(html, /<h2 class="vh">担当者の割り当て方を決める<\/h2>/)
  assert.match(html, /data-tab="todo"[^>]*>要対応<\/button>[^]*data-tab="whole"[^>]*>全体<\/button>[^]*data-tab="arch"[^>]*>対応済み<\/button>/)
  const stale = draw(base({ workers: [{ terminalId: 'a', title: 'w', agent: 'claude', state: 'working', since: NOW - 60000 }] }), ui({ tab: 'todo' }))
  // 利用者にすることが無く、指示を送った直後の数秒の差でも出るため（取り込み忘れはタスクの「メインの取り込み待ち」と hook が拾う）
  noMatch(stale, /操縦席の更新が|class="warn"/)
  // 窓では件数を上の帯と左の列に出すので、止まった worker が無ければ帯ごと出さない
  const w = { mode: 'manual' as const, focused: '/w', rows: [wsRow({ root: '/w', name: '案件' })], live: 0, view: fresh, errors: [] }
  noMatch(renderWindow(w, w.view, ui(), NOW, (s) => s), /<div class="bar">/)
})

/**
 * ブラウザと同じく、ボタンの中でボタンが始まったら外側を閉じて読む（HTML の解析の規則）。
 * 返すのは、その読み方で各 data-* の要素がどの class の要素の中に入ったか。
 */
function parsedParents(html: string, attrs: string[]): { nested: number; inside: Record<string, string[]> } {
  const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'col', 'area', 'source', 'wbr'])
  const stack: { tag: string; cls: string }[] = []
  const inside: Record<string, string[]> = {}
  let nested = 0
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, close, raw, rest] = m
    const tag = raw!.toLowerCase()
    if (tag === 'svg' || VOID.has(tag)) continue
    if (close) {
      const at = stack.map((s) => s.tag).lastIndexOf(tag)
      if (at >= 0) stack.length = at
      continue
    }
    if (tag === 'button' && stack.some((s) => s.tag === 'button')) {
      nested++
      stack.length = stack.map((s) => s.tag).lastIndexOf('button')
    }
    const cls = /class="([^"]*)"/.exec(rest!)?.[1] ?? ''
    for (const a of attrs) if (new RegExp(`\\b${a}[=\\s>]`).test(rest! + ' ')) (inside[a] ??= []).push(stack.map((s) => s.cls).join(' > '))
    stack.push({ tag, cls })
  }
  return { nested, inside }
}

test('詳細の欄の要素（選択肢・別の答え・リンク・詳細・返答のボタン）は、本文に #123 や URL があっても右の詳細の欄の中に収まる', () => {
  const c = sample()
  const d1 = c.items.find((i) => i.id === 'd1')!
  // 2026-11-16 に、選択肢の例の #1 がボタンの中のボタンになり、選択肢の 2 番目から下が左の一覧の下へこぼれた
  d1.repo = 'example/app'
  d1.options![0]!.example = '#1 AWS アカウントに足す。[資料](https://docs.google.com/x) と https://example.com/a も見る'
  d1.links = [{ label: '資料 A', href: 'https://docs.google.com/a' }, { label: '資料 B', href: 'https://docs.google.com/b' }]
  for (const tab of ['todo', 'whole', 'arch'] as const) {
    const html = draw(base({ cockpit: c }), ui({ tab, cur: 'd1' }))
    assert.equal(parsedParents(html, []).nested, 0, `${tab}: ボタンの中にボタンがある`)
  }
  const html = draw(base({ cockpit: c }), ui({ cur: 'd1' }))
  const { inside } = parsedParents(html, ['data-pick', 'data-otherbox', 'data-more', 'data-decide', 'data-href'])
  assert.equal(inside['data-pick']!.length, d1.options!.length, '選択肢が全部ある')
  for (const [a, where] of Object.entries(inside)) for (const w of where) assert.match(w, /\bsplit > detail\b/, `${a} が詳細の欄の外にある: ${w}`)
  assert.match(html, /<div class="ex"><span class="exl">例<\/span>#1 AWS アカウントに足す。資料 と example\.com\/a も見る<\/div>/)
})

test('要対応の一覧の行は、期限を種類の印と同じ 1 行目に置き、題名と説明は 2 行目から行の幅を使う', () => {
  const html = draw(base())
  assert.match(html, /data-id="d4"[^>]*>\s*<span class="rhead"><span class="kind k-dec hot"[^>]*>判断<\/span><span class="due mut num"><span class="over">! あと 22 時間 11\/17\(火\) 10:00<\/span><\/span><\/span><span><span class="t">通知メールの差出人を決める/)
  noMatch(html, /class="row irow"[^>]*>[^]*?<\/span><span class="due[^>]*>[^<]*<\/span><\/button>/)
})

test('2 つの大タスクに関係する確認は、一覧では代表の大タスクに 1 回だけ並び、関係するどの大タスクの画面にも出る。件数は代表の大タスクで数え、全体の行の合計は上の帯と同じ', () => {
  const v = base()
  const list = draw(v)
  assert.equal((list.match(/class="row irow" data-id="d1"/g) ?? []).length, 1)
  assert.ok(list.search(/data-id="d1"/) > list.search(/data-stream="s1"><span class="shn">/), 'd1 は代表の一覧画面の下')
  const s2 = draw(v, ui({ tab: 'whole', curStream: 's2' }))
  // 依頼 r1 の成果物の確認（v1・v2）も、依頼のタスク t2 経由で通知に関係する
  const own = Number(/あなたの対応 <span class="num">(\d+)<\/span> 件/.exec(s2)![1])
  const shared = Number(/ほかの大タスクと共通の要対応 <span class="num">(\d+)<\/span> 件/.exec(s2)![1])
  assert.equal(own + shared, 4, '通知に関係する確認は d4・d1・v1・v2 の 4 件')
  assert.match(s2.slice(s2.search(/ほかの大タスクと共通の要対応/)), /data-goto="d1"><span class="kind k-dec[^]*担当者の割り当て方を決める/)
  const table = draw(v, ui({ tab: 'whole' }))
  const n = (id: string) => Number(new RegExp(`data-stream="${id}">[^]*?<span class="ovt">(?:<b>要対応 <span class="num">(\\d+)</span>)?`).exec(table)![1] ?? 0)
  assert.equal(n('s1') + n('s2') + n('s3'), 7)
  assert.equal(n('s2'), own)
  assert.match(table, /要対応 <b class="num">7<\/b> 件/)
})

test('要対応を開いたときは、期限がいちばん近い確認を選ぶ（並びの先頭とは限らない）', () => {
  const c = sample()
  // 「通知」より「一覧画面」の大タスクが先に並ぶようにし、一覧画面の中の d5 より通知の d4 の期限を近くする
  c.items.find((i) => i.id === 'd4')!.due = '2026-11-18T13:00:00+09:00'
  c.items.find((i) => i.id === 'd5')!.due = '2026-11-18T12:00:00+09:00'
  c.items.find((i) => i.id === 'd1')!.due = '2026-11-18T11:00:00+09:00'
  c.items.find((i) => i.id === 'd3')!.due = '2026-11-30'
  c.items.find((i) => i.id === 'd1')!.related = [{ task: 't2' }]
  const html = draw(base({ cockpit: c }))
  assert.match(html, /data-id="d1" aria-current="true"/)
})

test('大タスクの状態: 済んでいないタスクがあればその状態、全タスク完了でも確認が開いていれば確認待ち、どちらも無ければ完了で畳む', () => {
  const c = sample()
  for (const t of c.tasks) if (t.stream === 's1' || t.stream === 's2') t.state = 'ok'
  // 依頼 r1 の成果物の確認（v1・v2）は related を持たないが、依頼のタスク経由で一覧画面と通知に入る
  c.items = c.items.filter((i) => !['d1', 'd3', 'd4', 'd5'].includes(i.id))
  const table = draw(base({ cockpit: c }), ui({ tab: 'whole' }))
  assert.match(table, /class="ovr" data-stream="s1">\s*<span class="ovn"><span class="st s-wait" title="あなたの確認待ち"/)
  assert.match(draw(base({ cockpit: c }), ui({ tab: 'whole', curStream: 's2' })), /<h2 class="eph">通知<\/h2><div class="epstat"><span class="epst"><span class="st s-wait"[^>]*>◆<\/span><b>あなたの確認待ち<\/b>/)
  c.items = c.items.filter((i) => i.kind !== 'rev')
  const done = draw(base({ cockpit: c }), ui({ tab: 'whole' }))
  noMatch(done, /data-stream="s1"|data-stream="s2"/)
  assert.match(done, /完了 <span class="num">3<\/span> 件/)
})

test('大タスクの画面: 頭（題名・状態・今の様子・ゴール）→ あなたの対応 → 経過 → タスク → 背景と資料。説明が無ければそう出し、依頼の原文と出典はいつも出す', () => {
  const c = sample()
  const s1 = c.streams.find((s) => s.id === 's1')!
  const bare = detailOf(draw(base({ cockpit: c }), ui({ tab: 'whole', curStream: 's1' })))
  assert.match(bare, /<nav class="crumbs" aria-label="たどり"><button class="tlink" data-whole>全体<\/button><span class="sep"[^>]*>›<\/span><span class="here">一覧画面<\/span><\/nav>/)
  assert.match(bare, /ゴールといきさつが未記入/)
  assert.match(bare, /あなたの依頼（原文）<\/div>[^]*data-req="r1">一覧画面と通知の案を見たい<\/button>[^]*<blockquote class="orig">定例の前に/)
  assert.match(bare, />出典<\/div>[^]*data-href="docs\/requirements.md"[^]*data-href="docs\/design\/一覧画面.md"/)
  assert.match(bare, /タスク 残り <span class="num">2<\/span> 件<span class="mut">（完了 <span class="num">1<\/span> 件）<\/span>[^]*data-task="t1"[^]*data-done="s1" aria-expanded="false">完了したタスク 1 件を表示/)
  s1.summary = '担当者が今日やる問い合わせだけを 1 画面で見られるようにする'
  s1.background = { text: '11/14 の定例で主任から、朝の振り分けに 30 分かかると話があった。', quote: '朝いちばんに全部見て振るのがしんどい', date: '2026-11-14' }
  s1.sources = ['project/minutes/2026-11-14.md:42']
  const full = detailOf(draw(base({ cockpit: c }), ui({ tab: 'whole', curStream: 's1' })))
  const at = (re: RegExp) => full.search(re)
  noMatch(full, /ゴールといきさつが未記入/)
  assert.match(full, /<blockquote>朝いちばんに全部見て振るのがしんどい<span class="num">　11\/14\(土\)<\/span><\/blockquote>/)
  const order = [/<span class="lbl">ゴール<\/span>担当者が今日やる/, /あなたの対応 <span/, /<h3 class="h">経過/, /<h3 class="h">タスク/, /<h3 class="h">背景と資料/, />いきさつ</, />あなたの依頼（原文）</, />出典</].map(at)
  assert.ok(order.every((n, k) => n > 0 && (k === 0 || order[k - 1]! < n)), `並び ${order}`)
  // 経過の最初は発端（background.date と text の最初の文）で、日付の古い順
  assert.match(full, /<span class="tld num">11\/14\(土\)<\/span><span class="tlk">発端<\/span><span class="tlt"><span>11\/14 の定例で主任から、朝の振り分けに 30 分かかると話があった。<\/span>/)
  assert.equal((full.match(/data-href="project\/minutes\/2026-11-14.md:42"/g) ?? []).length, 1, '大タスクとタスクの出典の重なりは 1 回')
})

test('確認から上がったときだけ「確認『○○』に戻る」を出し、戻る先が片付いていれば出さない。読み込みでは大タスクの説明の形を確かめる', () => {
  const back = { tab: 'todo' as const, item: 'd1', scroll: { '.list': 120, '.detail': 300 } }
  assert.match(draw(base(), ui({ tab: 'whole', curStream: 's1', back })), /<div class="backbar"><button class="btn sm" data-back>‹ 判断「担当者の割り当て方を決める」に戻る<\/button>/)
  assert.match(draw(base(), ui({ tab: 'whole', curTask: 't1', back })), /data-back>/)
  noMatch(draw(base(), ui({ tab: 'whole', back })), /data-back/)
  const ops = [{ op_id: 1, at: '2026-11-16T11:59:00+09:00', item_id: 'd1', item_rev: 1, type: 'decide' as const, option_id: 'auto' }]
  noMatch(draw(base({ log: { ops } }), ui({ tab: 'whole', curStream: 's1', back })), /data-back/)
  const text = readFileSync(new URL('../fixtures/sample.json', import.meta.url), 'utf8')
  const bad = (s: Record<string, unknown>) => { const j = JSON.parse(text); Object.assign(j.streams[0], s); return JSON.stringify(j) }
  assert.throws(() => parseCockpit(bad({ summary: 3 })), /streams の summary/)
  assert.throws(() => parseCockpit(bad({ background: 'x' })), /streams の summary/)
  assert.throws(() => parseCockpit(bad({ sources: [1] })), /streams の summary/)
  assert.equal(parseCockpit(bad({ summary: 'a', background: { text: 'b' }, sources: ['c'] })).streams[0]!.summary, 'a')
})

test('済んだ作業は文字列でも { text, at } でも読み、日時のある行だけを経過に並べる。形の違う done は断る', () => {
  const c = sample()
  const t1 = c.tasks.find((t) => t.id === 't1')!
  t1.done = ['日時の無い作業', { text: '画面の案を作った', at: '2026-11-15T09:00:00+09:00' }]
  const page = draw(base({ cockpit: c }), ui({ tab: 'whole', curStream: t1.stream }))
  assert.match(page, /<span class="tld num">11\/15\(日\) 09:00<\/span><span class="tlk">作業<\/span><span class="tlt"><span>画面の案を作った<\/span>/)
  noMatch(page.slice(page.search(/<ol class="tl">/), page.search(/<\/ol>/)), /日時の無い作業/)
  assert.match(detailOf(draw(base({ cockpit: c }), ui({ tab: 'whole', curTask: 't1' }))), /日時の無い作業[^]*11\/15\(日\) 09:00<\/span>　画面の案を作った/)
  const text = readFileSync(new URL('../fixtures/sample.json', import.meta.url), 'utf8')
  const j = JSON.parse(text)
  j.tasks[0].done = [{ at: '2026-11-15' }]
  assert.throws(() => parseCockpit(JSON.stringify(j)), /tasks の done の形/)
})
