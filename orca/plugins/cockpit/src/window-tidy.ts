/**
 * 窓の全体の「整理・棚卸し」（r132）。既定の指示を選ぶか自由に書いて窓口に送り、送った指示の今（送信待ち・実行中・完了と結果のカード）を追う（R90）。
 * 送るのは cockpit.user.json の tidy の操作で、ほかの操作と同じ郵便受けの合図で窓口に届く（R191）。定期では動かさない（R181）。
 */
import { TEXT_MAX, TIDY_KINDS, TIDY_LABEL, type Card, type Op, type TidyKind } from './model.ts'
import { fmtDate, nearDate } from './state.ts'
import { esc, keyOf, type Board, type Ui } from './view.ts'
import { fold } from './window-parts.ts'

/** 既定の指示の文。選ぶと欄に入り、深田さんが書き足す・書き換える。窓口の手順は種類（option_id）で分かれ、文は範囲と注文として読む。 */
export const TIDY_TEXT: Record<TidyKind, string> = {
  workers: 'この案件のworkerとworktreeを整理する。終わった・止まったままのworkerと、取り込み済みや使っていないworktreeを洗い出して片付け、結果を報告する。',
  cockpit: '操縦席を整理する。済んだのに開いたタスク・古いカード・状況の文が古い仕事・帳簿の抜けを洗い出して直し、結果を報告する。',
  inventory: 'Slack・関連ファイル・これまでのやり取りを読み、帳簿に無い依頼と古くなったタスクを棚卸しして報告する。\n見る範囲: 案件の見張る経路と発言の記録（直近2週間）'
}
const FREE = 'free'
const FREE_LABEL = '自由な指示'
const kindName = (o: Op) => TIDY_LABEL[o.option_id as TidyKind] ?? FREE_LABEL

/** queued: 窓口への合図の前（取り消しの猶予の 10 秒と、送れずに残ったもの）、running: 合図を送り窓口の反映待ち、done: 窓口が反映した。 */
export type TidyState = 'queued' | 'running' | 'done'
const STATE_LABEL: Record<TidyState, string> = { queued: '送信待ち', running: '実行中', done: '完了' }
export type TidyRow = { op: Op; state: TidyState; results: Card[] }

/** 送った指示（新しい順）。取り消した指示は出さない。結果は帳簿と控えのカードのうち tidy_op がその op を指すもの。 */
export function tidyRows(b: Board): TidyRow[] {
  const v = b.v
  const applied = new Set(v.cockpit?.applied_ops ?? [])
  const undone = new Set(v.log.ops.filter((o) => o.type === 'undo' && o.undo_of != null).map((o) => o.undo_of!))
  const cards = [...(v.cockpit?.cards ?? []), ...v.archive]
  return v.log.ops
    .filter((o) => o.type === 'tidy' && !undone.has(o.op_id))
    .map((op): TidyRow => ({
      op,
      state: applied.has(op.op_id) ? 'done' : op.op_id <= v.notifiedOp ? 'running' : 'queued',
      results: cards.filter((c) => c.tidy_op === op.op_id)
    }))
    .reverse()
}


/**
 * 全体のタブの先頭に置く欄。既定の指示 3 つと自由な指示のボタン（右の欄を開く入口なので選んだ印は付けない）、その下に済んでいない指示と最後の指示を行で出す（全部は右の欄）。
 */
export function tidyHead(b: Board, ui: Ui, now: number): string {
  const rows = tidyRows(b)
  const shown = rows.filter((r, i) => r.state !== 'done' || i === 0)
  const btn = (k: string, label: string) => `<button class="btn" type="button" data-tidy="${k}">${esc(label)}</button>`
  // 利用者の書いた文なので、和欧の間の空白を詰めない（verb）。
  const row = (r: TidyRow) => `<button type="button" class="cardrow" data-tidy="open" data-op="${r.op.op_id}" aria-current="${!!ui.tidy && ui.tidyOp === r.op.op_id}">
      <span class="kd">${esc(STATE_LABEL[r.state])}</span>
      <span class="tt"><span class="tl"><span class="ti">${esc(kindName(r.op))}</span></span><span class="crumb verb">${esc(oneLine(r.op.text))}</span></span>
      <span class="du">${esc(nearDate(r.op.at, now))}</span></button>`
  return `<section class="fsec tidy" aria-label="整理・棚卸し"><div class="tdh"><h3>整理・棚卸し</h3><div class="tdk">${TIDY_KINDS.map((k) => btn(k, TIDY_LABEL[k])).join('')}${btn(FREE, FREE_LABEL)}</div></div>
    ${shown.length ? `<div class="rows">${shown.map(row).join('')}</div>` : ''}</section>`
}

const oneLine = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** 右の欄。指示の種類・文・送るボタンと、送った指示の一覧（新しい順に 10 件、残りは畳む）。listed は窓の一覧で開けるカードの鍵。 */
export function tidyDetail(b: Board, ui: Ui, listed: Set<string>): string {
  const draft = ui.tidyDraft?.[b.root] ?? ''
  const busy = ui.tidySending === b.root
  const kind = (k: string, label: string) => `<button type="button" data-tidy="${k}" aria-pressed="${(ui.tidyKind?.[b.root] ?? FREE) === k}">${esc(label)}</button>`
  const form = `<div class="askin tidyin"><div class="afil" role="group" aria-label="指示の種類">${TIDY_KINDS.map((k) => kind(k, TIDY_LABEL[k])).join('')}${kind(FREE, FREE_LABEL)}</div>
    <label class="lb" for="tidy-text">窓口への指示</label>
    <textarea id="tidy-text" data-tidydraft="${esc(b.root)}" rows="4" maxlength="${TEXT_MAX}">${esc(draft)}</textarea>
    <div class="acts"><button class="btn pri" type="button" data-tidy="send"${busy || !draft.trim() ? ' disabled' : ''}>窓口に送る</button></div></div>`
  const rows = tidyRows(b)
  const result = (c: Card) => {
    const k = keyOf({ root: b.root, card: c })
    return listed.has(k) ? `<button type="button" class="alk" data-jump="${esc(k)}">${esc(c.title)}</button>` : `<span>${esc(c.title)}</span>`
  }
  // 状態は先頭の行の形（語・太さ・色）にそろえて先頭に置き、完了した指示は薄くする（結果のリンクは濃いまま）。行から開いた指示は選んだ印を付ける。
  const item = (r: TidyRow) => `<li class="s-${r.state}"${ui.tidyOp === r.op.op_id ? ' aria-current="true"' : ''} data-tidyitem="${r.op.op_id}"><span class="sl"><span class="tds">${esc(STATE_LABEL[r.state])}</span><span class="tm">${esc(fmtDate(r.op.at))}</span><b>${esc(kindName(r.op))}</b></span>
      <div class="quote verb">${esc(r.op.text ?? '')}</div>
      ${r.results.length ? `<div class="tres"><span class="lb">結果</span>${r.results.map(result).join('')}</div>` : r.state === 'done' ? '<div class="tres mut">結果のカードなし</div>' : ''}</li>`
  const list = rows.length
    ? `<div class="sent fld"><span class="lb">送った指示</span><ol>${rows.slice(0, 10).map(item).join('')}</ol>${rows.length > 10 ? fold(ui, `tidy:${b.root}`, `残り${rows.length - 10}件`, `<ol>${rows.slice(10).map(item).join('')}</ol>`) : ''}</div>`
    : ''
  return `<div class="wdet tidyd">
    <div class="dh"><div class="crumbs"><span>${esc(b.v.cockpit!.workspace.name)}</span></div><h2>整理・棚卸し</h2></div>
    <div class="first">${form}</div>${list}</div>`
}

/** 種類を選んだときに欄に入れる文。自由な指示は、既定の文のままなら空にし、書き換えた文は残す。 */
export function tidyDraftFor(kind: string, draft: string): string {
  if (TIDY_KINDS.includes(kind as TidyKind)) return TIDY_TEXT[kind as TidyKind]
  return Object.values(TIDY_TEXT).includes(draft) ? '' : draft
}
