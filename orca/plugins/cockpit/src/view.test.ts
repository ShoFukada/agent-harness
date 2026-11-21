import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample } from '../fixtures/sample.ts'
import { parseCockpit } from './model.ts'
import type { CockpitView } from './protocol.ts'
import { boardsOf, linkKind, newUi, preface, render, rich, talkMessage, type Model, type Ui } from './view.ts'

const NOW = Date.parse('2026-11-21T10:00:00+09:00')
const svg = (s: string) => s
function views(): CockpitView[] {
  return sample(NOW).map((w) => ({
    state: 'ok', root: `/ws/${w.dir}`, cockpit: structuredClone(w.cockpit), log: structuredClone(w.log), archive: [], figures: w.figure ? { '.orca/cockpit/figures/entry.svg': w.figure } : {},
    errors: [], workers: [], notifiedOp: 0
  }))
}
const model = (over: Partial<Model> = {}, vs = views()): Model => ({ boards: boardsOf(vs, NOW), unseen: [], errors: [], ...over })
const html = (m: Model = model(), ui: Ui = newUi()) => render(m, ui, NOW, svg)
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

test('上の帯: 全案件の私の番の合計と 5 種類の内訳。届いたは区切りの外に出し、合計に入れない', () => {
  const t = text(html())
  assert.match(t, /9 全案件の私の番/)
  assert.match(t, /許す 2 決める 3 送る前 1 見て 2 届いた 1/)
  assert.match(html(), /class="kc ref k-inbox"/)
})

test('1 列: 止まっている → 期限切れ → 今の線 → 今日 → 明日 → 今週 → 期限なし の順で、期限切れは今の線より上', () => {
  const h = html()
  const t = text(h.slice(h.indexOf('class="queue"')))
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

test('決める: 何のため → なぜ今 → 選択肢 → 返事が無いとき → 決めるための情報 → 話す相手。おすすめを選んだ状態で開き「おすすめで決める」、選び直すと「この案で決める」', () => {
  const ui = { ...newUi(), sel: '/ws/aoba#d21' }
  const t = text(html(model(), ui))
  const order = ['何のため', 'なぜ今決めるか', '図はこのまま', '返事が無いとき', 'これは何か', '失うこと', '話す相手 AWS 構成案'].map((x) => t.indexOf(x))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.match(html(model(), ui), /data-act="decide"[^>]*\s>おすすめで決める/)
  assert.match(html(model(), ui), /role="radio" aria-checked="true" data-pick="keep"/)
  ui.picked['/ws/aoba#d21'] = 'draw'
  assert.match(html(model(), ui), /data-act="decide"[^>]*>この案で決める/)
  assert.match(html(model(), ui), /role="radio" aria-checked="true" data-pick="draw"/)
  // おすすめの無いカードと、戻せない操作を含む詰まり・許すは、選ぶまで押せない。
  assert.match(html(model(), { ...newUi(), sel: '/ws/harness#d28' }), /data-act="decide"[^>]*disabled>選択肢を選ぶ/)
  assert.match(html(model(), { ...newUi(), sel: '/ws/konan#k9' }), /data-act="decide"[^>]*disabled>選択肢を選ぶ/)
  // 別の答えを開いたら、文が空のうちはおすすめでも決められない。
  const other = { ...newUi(), sel: '/ws/aoba#d21', otherOpen: { '/ws/aoba#d21': true }, other: { '/ws/aoba#d21': '  ' } }
  assert.match(html(model(), other), /data-act="decide"[^>]*disabled>別の答えで決める/)
})

test('今日の見出しの日付は手元の時計で決める（日本時間の朝 9 時前でも前日にならない）', () => {
  const early = Date.parse('2026-11-21T07:00:00+09:00')
  assert.match(text(render(model(), newUi(), early, svg)), /今日 11\/21\(土\)/)
})

test('期限は、1 列の見出しと重なる日付を省く（今日は時刻だけ、明日は「明日 18:00」）', () => {
  const h = html()
  assert.match(h, /due hot"><b>! あと 3 時間<\/b><span class="tm">13:00<\/span>/)
  assert.match(h, /<span class="due">明日 18:00<\/span>/)
  assert.match(h, /<span class="due">11\/24\(火\) 17:00<\/span>/)
})

test('案件の列は、止まっている・期限切れ・今日・話し中の件数を出す（日時は出さない）', () => {
  const h = html()
  const aoba = text(h.slice(h.indexOf('data-filter="/ws/aoba"'), h.indexOf('</button>', h.indexOf('data-filter="/ws/aoba"'))))
  assert.match(aoba, /期限切れ 1 今日 1 話し中 1/)
  assert.ok(!aoba.includes('最短'))
})

test('担当と話すの知らせは、次に押す場所を名前で言う', () => {
  assert.equal(talkMessage({ opened: true, how: 'ワークスペース「aoba」', tab: 'AWS 構成案（担当）' }, true), 'ワークスペース「aoba」を前に出しました。チャットの「AWS 構成案（担当）」を開き、書き出しをコピーしたので、貼って話してください')
  assert.equal(talkMessage({ opened: true, how: '窓口の端末' }, false), '窓口の端末を開きました。話してください')
  assert.equal(talkMessage({ opened: false, how: '窓口の端末' }, true), '窓口の端末を開けませんでした。Orca で開き、書き出しをコピーしたので、貼って話してください')
  // 開けなかった理由があれば、何も起きなかったように見せず、理由を出す。
  assert.equal(talkMessage({ opened: false, how: '窓の版 3のチャット', reason: '担当「窓の版 3」のチャットの居場所の worktree（gone）が Orca にありません。片付けられたようです' }, true),
    '開けませんでした: 担当「窓の版 3」のチャットの居場所の worktree（gone）が Orca にありません。片付けられたようです')
})

test('見て: 「直してほしいことを書く」で書く欄を開き、本文が空のうちは頼めない。頼んだら直し待ちになり、頼んだ文を出す', () => {
  const k = '/ws/aoba#r5'
  const acts = (ui: Ui, vs = views()) => {
    const h = html(model({}, vs), ui)
    return [...h.slice(h.indexOf('class="queue"')).matchAll(/data-act="([a-z]+)"[^>]*>([^<]+)</g)].map((m) => `${m[1]}:${m[2]}`)
  }
  const open = { ...newUi(), sel: k, otherOpen: { [k]: true }, other: { [k]: ' ' } }
  assert.deepEqual(acts(open), ['accept:これでよい', 'other:書くのをやめる', 'decide:この直しを頼む', 'talk:直してほしい（担当と話す）', 'url:開く'])
  assert.match(html(model(), open), /data-act="decide"[^>]*disabled>この直しを頼む/)
  assert.match(html(model(), open), /直してほしいこと（書いた文のまま担当か窓口に届きます）/)
  const vs = views()
  vs[0]!.log.ops.push({ op_id: 9, at: new Date(NOW).toISOString(), item_id: 'r5', item_rev: 1, type: 'talk', text: '凡例を上に寄せてほしい' })
  const m = model({}, vs)
  assert.ok(!m.boards[0]!.d.queue.some((r) => r.card.id === 'r5'), '件数から外れる')
  const h = html(m, { ...newUi(), sel: k })
  assert.match(h, /<span>直しを頼んだ（受け取り待ち）<\/span>/)
  assert.match(text(h), /頼んだ直し 凡例を上に寄せてほしい/)
})

test('カードの欄の形が違っても全体の描画を止めず、その欄を外してカードを名指しする', () => {
  const raw = JSON.parse(JSON.stringify(sample(NOW)[0]!.cockpit)) as { cards: Record<string, unknown>[]; tasks: Record<string, unknown>[] }
  // 2026-11-21 に窓口が v88・v89 の evidence を文字列で書き、見てのカードが押せなくなった。
  const wrong: Record<string, unknown> = { evidence: '確かめた', look_for: 'x', options: 'x', compare: 3, from: 'x', draft: 'x', context: 'x', background: 'x', last: 'x',
    done: 'x', awaiting: 'x', links: 'x', tasks: 'x', due: 5, purpose: 5, href: 5, answerable: 'x', reply: 'x', repo: 5, since: 5, manual: 'x' }
  for (const c of raw.cards) Object.assign(c, wrong)
  raw.tasks[0]!.next = 5
  raw.cards[1]!.manual = { command: 'sudo darwin-rebuild switch', steps: '実行後に確認' }
  const problems: string[] = []
  const cockpit = parseCockpit(JSON.stringify(raw), problems)
  assert.equal(cockpit.cards.length, raw.cards.length)
  assert.ok(problems.some((p) => /カード r5「[^」]+」の .*evidence/.test(p)), problems.join('\n'))
  assert.ok(problems.some((p) => /タスク t1 の next/.test(p)), problems.join('\n'))
  const vs = views()
  vs[0]!.cockpit = cockpit
  // 手作業の頼みは、形の違う下の欄だけを外し、「済ませた」で返す票のままにする。
  assert.deepEqual(cockpit.cards[1]!.manual, { command: 'sudo darwin-rebuild switch' })
  assert.deepEqual(cockpit.cards[0]!.manual, {})
  for (const c of cockpit.cards) assert.doesNotThrow(() => html(model({}, vs), { ...newUi(), sel: `/ws/aoba#${c.id}` }), c.id)
})

test('詰まりの題に仕事の名前があれば、上の行に同じ名前を出さない', () => {
  const h = html()
  const strip = h.slice(h.indexOf('data-strip="/ws/konan#k9"'))
  assert.ok(!strip.slice(0, strip.indexOf('</article>')).includes('class="jobname"'))
})

test('種類ごとの返答: 送る前はコピーしてスレッドを開く・送った・担当と直す・送らない、見ては これでよい・直してほしい、許すは 許す・任せる・止める', () => {
  const acts = (sel: string) => {
    const h = html(model(), { ...newUi(), sel })
    return [...h.slice(h.indexOf('class="queue"')).matchAll(/data-act="([a-z]+)"[^>]*>([^<]+)</g)].map((m) => `${m[1]}:${m[2]}`)
  }
  assert.deepEqual(acts('/ws/aoba#d22'), ['copy:コピーしてスレッドを開く', 'sent:送った', 'talk:担当と直す', 'skip:送らない'])
  assert.deepEqual(acts('/ws/aoba#r5'), ['accept:これでよい', 'other:直してほしいことを書く', 'talk:直してほしい（担当と話す）', 'url:開く'])
  assert.deepEqual(acts('/ws/konan#p7'), ['accept:許す', 'delegate:この案件の 本番 は任せる', 'skip:止める', 'talk:担当と話す'])
  assert.deepEqual(acts('/ws/aoba#i3'), ['talk:担当と話す', 'skip:返事は要らない', 'url:元の連絡を開く'])
  // 手作業を頼む許す（manual）は、どこで・打つコマンド・手順を先に出し、「済ませた」を主にする（2026-11-21 に switch を頼むカードで、コマンドが無く、打ったあと押すボタンも無かった）。
  const vs = views()
  const p7 = vs[1]!.cockpit!.cards.find((c) => c.id === 'p7')!
  p7.manual = { where: 'ターミナル', command: 'sudo darwin-rebuild switch --flake ~/.config/nix-darwin', steps: ['パスワードを入れる', '終わったら「済ませた」を押す'], check: '窓口が launchctl list で確かめる' }
  const h = html(model({}, vs), { ...newUi(), sel: '/ws/konan#p7' })
  assert.deepEqual([...h.slice(h.indexOf('class="queue"')).matchAll(/data-act="([a-z]+)"[^>]*>([^<]+)</g)].map((m) => `${m[1]}:${m[2]}`), ['copycmd:コピー', 'sent:済ませた', 'talk:担当と話す'])
  const t = text(h.slice(h.indexOf('data-strip="/ws/konan#p7"')))
  const order = ['どこで ターミナル', '打つコマンド sudo darwin-rebuild switch --flake ~/.config/nix-darwin', '手順 パスワードを入れる', '済ませたあと 窓口が launchctl list で確かめる'].map((x) => t.indexOf(x))
  assert.ok(order.every((n) => n >= 0) && [...order].sort((a, b) => a - b).join() === order.join(), t)
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
  assert.match(h, /class="r sp hot"><span class="pt">森さん<\/span><span class="pt">.* から<\/span><span class="pt">催促の日を過ぎた<\/span>/)
  assert.ok(!/class="r[^"]*">[^<]*・/.test(h), '補足を「・」で繋がない')
  assert.match(t, /片付いた 2/)
  assert.match(t, /受け取り待ち これでよい/)
})

test('何もしなくてよいのは見ていないものが無いときだけ。見ていない案件・読めていない経路があればそう出す', () => {
  const empty = views().map((v) => ({ ...v, cockpit: { ...v.cockpit!, cards: [], routes: [] } }))
  assert.match(text(html(model({}, empty))), /何もしなくてよい/)
  const t = text(html(model({ unseen: [{ name: '試し置き場', path: '/x' }] }, empty)))
  assert.match(t, /私の番はありません。ただし見ていないものがあります/)
  assert.match(t, /見ていない 1/)
  // 一覧は上の帯の「見ていない n」から開き、案件の列には重ねて出さない。
  assert.ok(!/Teams 病院の情報部: .* から読めていない/.test(text(html(model()))))
  assert.match(text(html(model(), { ...newUi(), open: { unseen: true } })), /Teams 病院の情報部: .* から読めていない/)
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

test('片付いた票を開いても片付ける操作は出さない。版 1 のままの案件は「見ていない」に理由つきで出す', () => {
  const vs = views()
  vs[0]!.log.ops.push({ op_id: 2, at: new Date(NOW).toISOString(), item_id: 'r5', item_rev: 1, type: 'accept' })
  const h = html(model({}, vs), { ...newUi(), sel: '/ws/aoba#r5' })
  const strip = h.slice(h.indexOf('data-strip="/ws/aoba#r5"'))
  assert.ok(!/data-act="accept"/.test(strip.slice(0, strip.indexOf('</article>'))))
  const t = text(html(model({ unseen: [{ name: 'old', path: '/ws/old', why: 'cockpit.json を読めません: 版 1 です' }] }, [])))
  assert.match(t, /私の番はありません。ただし見ていないものがあります old: cockpit.json を読めません: 版 1 です/)
})

test('コミット・ブランチ・識別子・ID は等幅にし、URL のボタンの中は触らない', () => {
  const r = rich('release/2026-11-21（a1b2c3d..e4f5a6b） fk_unresolved ADR-0002 `claude auth login` https://example.com/a_b/c1', 'example/repo')
  for (const x of ['release/2026-11-21', 'a1b2c3d..e4f5a6b', 'fk_unresolved', 'ADR-0002', 'claude auth login']) assert.ok(r.includes(`<span class="code">${x}</span>`), x)
  assert.match(r, /data-url="https:\/\/example.com\/a_b\/c1"/)
})
