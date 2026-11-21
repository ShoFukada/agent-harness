import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import type { CockpitView } from './protocol.ts'
import { boardsOf, linkKind, newUi, preface, render, rich, type Model, type Ui } from './view.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const svg = (s: string) => s
function views(): CockpitView[] {
  return sample(NOW).map((w) => ({
    state: 'ok', root: `/ws/${w.dir}`, cockpit: structuredClone(w.cockpit), log: structuredClone(w.log), archive: [], figures: w.figure ? { '.orca/cockpit/figures/entry.svg': w.figure } : {},
    errors: [], workers: [], worktrees: [], notifiedOp: 0
  }))
}
const model = (over: Partial<Model> = {}, vs = views()): Model => ({ boards: boardsOf(vs, NOW), unseen: [], errors: [], ...over })
const html = (m: Model = model(), ui: Ui = newUi()) => render(m, ui, NOW, svg)
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

test('上の帯: 全案件の私の番の合計と 5 種類の内訳。届いたは「数えない」で区切る', () => {
  const t = text(html())
  assert.match(t, /9 全案件の私の番/)
  assert.match(t, /許す 2 決める 3 送る前 1 見て 2 数えない 届いた 1/)
})

test('1 列: 止まっている → 期限切れ → 今の線 → 今日 → 明日 → 今週 → 期限なし の順で、期限切れは今の線より上', () => {
  const t = text(html())
  const order = ['止まっている', '期限切れ', '今 10:00', '今日', '明日', '今週', '期限なし'].map((x) => t.indexOf(x))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.ok(order.every((n) => n >= 0))
})

test('朱は期限が 24 時間以内か過ぎた票だけ。文字でも「! あと n 時間」「! 過ぎた」と出す', () => {
  const h = html()
  assert.match(h, /due hot"><b>! 過ぎた<\/b>/)
  assert.match(h, /due hot"><b>! あと 3 時間<\/b>/)
  assert.ok(!/k-review hot/.test(h.match(/<article class="strip k-review[^"]*"[^>]*data-strip="\/ws\/harness#r8"/)?.[0] ?? ''))
})

test('案件で絞ると、その案件の票だけになり、右に案件の今（節目と仕事ごとの状態）が出る。案件名は票に出さない', () => {
  const ui = { ...newUi(), filter: '/ws/aoba' }
  const h = html(model(), ui)
  const t = text(h)
  assert.match(t, /3 青葉物流 配車アプリ の私の番/)
  assert.ok(!h.includes('class="ws"'))
  assert.ok(!h.includes('data-strip="/ws/konan'))
  assert.match(t, /あと 2 日 定例/)
  assert.match(t, /配車画面の改修 私待ち 1 件/)
  assert.match(t, /外部 API の繋ぎ込み 森さんの返事待ち/)
})

test('決める: 何のため → なぜ今 → 決めるための情報 → 選択肢 → 返事が無いとき → 話す相手。選ぶ前は押せない「選択肢を選ぶ」、選んだ後は「この案で決める」', () => {
  const ui = { ...newUi(), sel: '/ws/aoba#d21' }
  const t = text(html(model(), ui))
  const order = ['何のため', 'なぜ今決めるか', 'これは何か', '失うこと', '図はこのまま', '返事が無いとき', '話す相手 AWS 構成案'].map((x) => t.indexOf(x))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.match(html(model(), ui), /data-act="decide"[^>]*disabled>選択肢を選ぶ/)
  ui.picked['/ws/aoba#d21'] = 'keep'
  assert.match(html(model(), ui), /data-act="decide"[^>]*>この案で決める/)
  assert.match(html(model(), ui), /role="radio" aria-checked="true"/)
})

test('種類ごとの返答: 送る前はコピーしてスレッドを開く・送った・担当と直す・送らない、見ては これでよい・直してほしい、許すは 許す・任せる・止める', () => {
  const acts = (sel: string) => {
    const h = html(model(), { ...newUi(), sel })
    return [...h.matchAll(/data-act="([a-z]+)"[^>]*>([^<]+)</g)].map((m) => `${m[1]}:${m[2]}`)
  }
  assert.deepEqual(acts('/ws/aoba#d22'), ['copy:コピーしてスレッドを開く', 'sent:送った', 'talk:担当と直す', 'skip:送らない'])
  assert.deepEqual(acts('/ws/aoba#r5'), ['accept:これでよい', 'talk:直してほしい（担当と話す）', 'url:開く'])
  assert.deepEqual(acts('/ws/konan#p7'), ['accept:許す', 'delegate:この案件の 本番 は任せる', 'skip:止める', 'talk:担当と話す'])
  assert.deepEqual(acts('/ws/aoba#i3'), ['talk:担当と話す', 'skip:返事は要らない', 'url:元の連絡を開く'])
  assert.deepEqual(acts('/ws/konan#a4').slice(0, 3), ['revert:戻して', 'revert:戻して', 'revert:戻して'])
})

test('送る前は宛先と改行を保った本文を出す。詰まりは理由と「答えれば進むか」', () => {
  const t = html(model(), { ...newUi(), sel: '/ws/aoba#d22' })
  assert.match(t, /<div class="msg">@森 @林\nお疲れさまです。/)
  const k = text(html(model(), { ...newUi(), sel: '/ws/konan#k9' }))
  assert.match(k, /私が答えれば進むか 進む。stg の DB の鍵を入れ直してよいかを答える/)
})

test('右の列: 話し中・顧客待ち（催促の日を過ぎたら朱）・報告・片付いた（受け取り待ち・受け取った）', () => {
  const vs = views()
  vs[0]!.log.ops.push({ op_id: 2, at: new Date(NOW).toISOString(), item_id: 'r5', item_rev: 1, type: 'accept' })
  const h = html(model({}, vs))
  const t = text(h)
  assert.match(t, /話し中 1/)
  assert.match(t, /顧客待ち 1/)
  assert.match(h, /class="r hot">森さん・.* から・催促の日を過ぎた/)
  assert.match(t, /片付いた 2/)
  assert.match(t, /受け取り待ち これでよい/)
})

test('何もしなくてよいのは見ていないものが無いときだけ。見ていない案件・読めていない経路があればそう出す', () => {
  const empty = views().map((v) => ({ ...v, cockpit: { ...v.cockpit!, cards: [], routes: [] } }))
  assert.match(text(html(model({}, empty))), /何もしなくてよい/)
  const t = text(html(model({ unseen: [{ name: '試し置き場', path: '/x' }] }, empty)))
  assert.match(t, /私の番はありません。ただし見ていないものがあります/)
  assert.match(t, /見ていない 1/)
  assert.match(text(html(model())), /Teams 病院の情報部: .* から読めていない/)
  // 案件で絞ったときは、ほかの案件の見ていないものでその案件を警告しない。
  const f = html(model({ unseen: [{ name: '試し置き場', path: '/x' }] }, empty), { ...newUi(), filter: '/ws/hokuto' })
  assert.match(text(f), /何もしなくてよい/)
  assert.ok(!f.includes('calm warn'))
})

test('パネルは前面の案件 1 つ: 案件の列と地の色の切り替えを出さず、案件の今を出す', () => {
  const h = html(model({ panel: true }, [views()[1]!]))
  assert.ok(!h.includes('data-filter'))
  assert.ok(!h.includes('data-theme="dark"'))
  assert.match(text(h), /港南病院 予約（運用保守） 案件の今/)
})

test('ファイルの文字列は HTML として解釈しない。URL と #123 は押せる形にし、「- 」は箇条にする', () => {
  const vs = views()
  vs[2]!.cockpit!.cards[2]!.title = '<img src=x onerror=alert(1)>'
  assert.ok(!html(model({}, vs)).includes('<img src=x'))
  const r = rich('- 一つ目 https://example.com/a\n- #12 を直す', 'example/repo')
  assert.match(r, /<ul><li>一つ目 <button class="inl" type="button" data-url="https:\/\/example.com\/a">/)
  assert.match(r, /data-url="https:\/\/github.com\/example\/repo\/pull\/12">#12/)
  assert.equal(linkKind('https://github.com/a/b/pull/1'), 'PR')
  assert.equal(linkKind('https://docs.google.com/x'), 'Drive')
  assert.equal(linkKind('docs/設計.md:12'), 'ファイル')
})

test('「元に戻す」は知らせと別に、操作ごとに積んで残りの秒を数える（続けて決めても前の操作を戻せる）', () => {
  const u = (opId: number, text: string, s: number) => ({ root: '/ws/aoba', opId, itemId: 'd21', rev: 1, text, until: NOW + s * 1000 })
  const ui = { ...newUi(), toast: { text: '本文をコピーしました', until: NOW + 5000 }, undos: [u(2, '決めました「x」', 4), u(3, '承りました「y」', 9), u(4, '古い', -1)] }
  const h = html(model(), ui)
  assert.match(text(h), /本文をコピーしました 決めました「x」。担当に届けます 元に戻す（4） 承りました「y」。担当に届けます 元に戻す（9）/)
  assert.ok(!h.includes('古い'))
  assert.match(h, /data-act="undo" data-op="2" data-root="\/ws\/aoba"/)
})

test('担当に貼る書き出しは、カードの id・種類・題・何のため', () => {
  const b = boardsOf(views(), NOW)[0]!
  const r = b.d.queue.find((x) => x.card.id === 'd21')!
  assert.equal(preface(r), '【操縦席 d21・決める】構成案の本番の図に、社内向けの入口を描き足すか\n何のため: 構成案の図が決まり、送る版を作れる\nこの件で: ')
})
