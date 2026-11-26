/**
 * 窓の全体の「整理・棚卸し」（r132）。既定の指示を選ぶか自由に書いて窓口に送り、窓口が反映するまでの指示を出す（R90）。
 * 送るのは cockpit.user.json の tidy の操作で、ほかの操作と同じ郵便受けの合図で窓口に届く（R191）。定期では動かさない（R181）。
 * 窓口が反映した指示（applied_ops に入った指示。cockpit-write が結果の報告のカードと一緒でなければ入れない）は一覧から消え、結果は報告の列に残る（t163）。
 */
import { openTidyOps, sameTidy, TEXT_MAX, TIDY_KINDS, TIDY_LABEL, type Op, type TidyKind } from './model.ts'
import { fmtDate } from './state.ts'
import { ago, esc, type Board, type Ui } from './view.ts'

/** 既定の指示の文。選ぶと欄に入り、深田さんが書き足す・書き換える。窓口の手順は種類（option_id）で分かれ、文は範囲と注文として読む。 */
export const TIDY_TEXT: Record<TidyKind, string> = {
  workers: 'この案件のworkerとworktreeを整理する。終わった・止まったままのworkerと、取り込み済みや使っていないworktreeを洗い出して片付け、結果を報告する。',
  cockpit: '操縦席を整理する。済んだのに開いたタスク・古いカード・状況の文が古い仕事・帳簿の抜けを洗い出して直し、結果を報告する。',
  inventory: 'Slack・関連ファイル・これまでのやり取りを読み、帳簿に無い依頼と古くなったタスクを棚卸しして報告する。\n見る範囲: 案件の見張る経路と発言の記録（直近2週間）'
}
const FREE = 'free'
const FREE_LABEL = '自由な指示'
const kindName = (o: Op) => TIDY_LABEL[o.option_id as TidyKind] ?? FREE_LABEL

/**
 * queued: 窓口への合図の前（取り消しの猶予の 10 秒と、送れずに残ったもの）、waiting: 合図を送り、窓口の反映を待っている。
 * 窓口が受け取って動いているかは窓から分からないので「実行中」とは出さず、送ってからの時間を添える。
 */
export type TidyState = 'queued' | 'waiting'
const STATE_LABEL: Record<TidyState, string> = { queued: '送信待ち', waiting: '反映待ち' }
export type TidyRow = { op: Op; state: TidyState }

/** 窓口がまだ反映していない指示（新しい順）。反映した指示と取り消した指示は出さない。 */
export function tidyRows(b: Board): TidyRow[] {
  return openTidyOps(b.v.cockpit, b.v.log)
    .map((op): TidyRow => ({ op, state: op.op_id <= b.v.notifiedOp ? 'waiting' : 'queued' }))
    .reverse()
}

/** 送ってからの時間（「3 時間前から」）。止まっている長さを見て、窓口に声をかけるかを決められるようにする。 */
const waited = (op: Op, now: number) => (now - Date.parse(op.at) < 60_000 ? 'たった今' : `${ago(op.at, now)}前から`)

/** 全体のタブの先頭に置く欄。既定の指示 3 つと自由な指示のボタン（右の欄を開く入口なので選んだ印は付けない）、その下に反映待ちの指示を行で出す。 */
export function tidyHead(b: Board, ui: Ui, now: number): string {
  const rows = tidyRows(b)
  const btn = (k: string, label: string) => `<button class="btn" type="button" data-tidy="${k}">${esc(label)}</button>`
  // 利用者の書いた文なので、和欧の間の空白を詰めない（verb）。
  const row = (r: TidyRow) => `<button type="button" class="cardrow" data-tidy="open" data-op="${r.op.op_id}" aria-current="${!!ui.tidy && ui.tidyOp === r.op.op_id}">
      <span class="kd">${esc(STATE_LABEL[r.state])}</span>
      <span class="tt"><span class="tl"><span class="ti">${esc(kindName(r.op))}</span></span><span class="crumb verb">${esc(oneLine(r.op.text))}</span></span>
      <span class="du">${esc(waited(r.op, now))}</span></button>`
  return `<section class="fsec tidy" aria-label="整理・棚卸し"><div class="tdh"><h3>整理・棚卸し</h3><div class="tdk">${TIDY_KINDS.map((k) => btn(k, TIDY_LABEL[k])).join('')}${btn(FREE, FREE_LABEL)}</div></div>
    ${rows.length ? `<div class="rows">${rows.map(row).join('')}</div>` : ''}</section>`
}

const oneLine = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** 欄の種類と文と同じ指示が反映待ちなら、その指示（同じ指示は窓口が反映するまで重ねて送らない。store の check も断る）。 */
export function pendingSame(b: Board, kind: string | undefined, text: string): Op | undefined {
  const k = TIDY_KINDS.includes(kind as TidyKind) ? kind : undefined
  return tidyRows(b).find((r) => sameTidy(r.op, k, text))?.op
}

/** 右の欄。指示の種類・文・送るボタンと、反映待ちの指示の一覧（新しい順）。 */
export function tidyDetail(b: Board, ui: Ui, now: number): string {
  const draft = ui.tidyDraft?.[b.root] ?? ''
  const busy = ui.tidySending === b.root
  const picked = ui.tidyKind?.[b.root] ?? FREE
  const same = draft.trim() ? pendingSame(b, picked, draft) : undefined
  const kind = (k: string, label: string) => `<button type="button" data-tidy="${k}" aria-pressed="${picked === k}">${esc(label)}</button>`
  const form = `<div class="askin tidyin"><div class="afil" role="group" aria-label="指示の種類">${TIDY_KINDS.map((k) => kind(k, TIDY_LABEL[k])).join('')}${kind(FREE, FREE_LABEL)}</div>
    <label class="lb" for="tidy-text">窓口への指示</label>
    <textarea id="tidy-text" data-tidydraft="${esc(b.root)}" rows="4" maxlength="${TEXT_MAX}">${esc(draft)}</textarea>
    <div class="acts"><button class="btn pri" type="button" data-tidy="send"${busy || !draft.trim() || same ? ' disabled' : ''}>窓口に送る</button></div>
    <p class="mut" data-tidysame${same ? '' : ' hidden'}>同じ指示が反映待ちです（下の一覧）。窓口が反映すると一覧から消え、結果は報告に出ます</p></div>`
  const rows = tidyRows(b)
  // 状態は先頭の行の形（語・太さ・色）にそろえて先頭に置く。行から開いた指示は選んだ印を付ける。
  const item = (r: TidyRow) => `<li${ui.tidyOp === r.op.op_id ? ' aria-current="true"' : ''} data-tidyitem="${r.op.op_id}"><span class="sl"><span class="tds">${esc(STATE_LABEL[r.state])}</span><span class="tm">${esc(fmtDate(r.op.at))}に送った・${esc(waited(r.op, now))}</span><b>${esc(kindName(r.op))}</b></span>
      <div class="quote verb">${esc(r.op.text ?? '')}</div></li>`
  const list = rows.length ? `<div class="sent fld"><span class="lb">反映待ちの指示</span><ol>${rows.map(item).join('')}</ol></div>` : ''
  return `<div class="wdet tidyd">
    <div class="dh"><div class="crumbs"><span>${esc(b.v.cockpit!.workspace.name)}</span></div><h2>整理・棚卸し</h2></div>
    <div class="first">${form}</div>${list}</div>`
}

/** 種類を選んだときに欄に入れる文。自由な指示は、既定の文のままなら空にし、書き換えた文は残す。 */
export function tidyDraftFor(kind: string, draft: string): string {
  if (TIDY_KINDS.includes(kind as TidyKind)) return TIDY_TEXT[kind as TidyKind]
  return Object.values(TIDY_TEXT).includes(draft) ? '' : draft
}
