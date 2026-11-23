import { COWORK_ID, TEXT_MAX } from './model.ts'
import { esc, fld, keyOf, type Ui, type VRow } from './view.ts'

export type AnswerWay = 'keys' | 'reply' | 'dispatch'
export function answerWay(r: VRow): AnswerWay | undefined {
  const a = r.agent
  if (r.status !== 'mine' || !a?.ask) return undefined
  if (r.card.id.startsWith('#ask:')) return 'reply'
  // 端末・チャットの問いで止まっている（stop がある）。チャットは画面を読めず、キーも送れない。
  if (a.stop) return !a.chat && a.terminalId && a.ask.sig ? 'keys' : undefined
  return r.card.id.startsWith(COWORK_ID) ? 'dispatch' : undefined
}

const WHERE: Record<AnswerWay, string> = { keys: '端末に送る', reply: '聞いた worker に返す', dispatch: '担当に送る' }

const busyOf = (ui: Ui, k: string) => !!ui.answering?.[k] && !ui.answering[k]!.error
const btnOf = (k: string, busy: boolean) => (label: string, attrs: string, cls = '') =>
  `<button class="btn${cls ? ` ${cls}` : ''}" type="button" data-act="answer" data-key="${esc(k)}" ${attrs}${busy ? ' disabled' : ''}>${esc(label)}</button>`

/** 選択肢のボタン（下の固定の行に、ほかの返答のボタンと同じ格で置く）。許可は 1 番（今回だけ）を塗りの主ボタンにする。 */
export function answerActs(r: VRow, ui: Ui): string {
  const way = answerWay(r)
  const ask = r.agent?.ask
  if (!way || !ask) return ''
  const btn = btnOf(keyOf(r), busyOf(ui, keyOf(r)))
  return way === 'keys' ? (ask.choices ?? []).map((c, i) => btn(c.label, `data-choice="${c.n}"`, ask.kind === 'permit' && i === 0 ? 'pri' : '')).join('')
    : way === 'reply' ? (ask.options ?? []).map((o, i) => btn(o, `data-pick="${i}"`)).join('') : ''
}

/** 下の固定の行: 選択肢のボタンを先に置き、開く・対応済みにするは枠のボタンにする（塗りの主ボタンは 1 画面に 1 つ）。 */
export const withAnswerActs = (r: VRow, ui: Ui, acts: string) =>
  answerWay(r) ? acts.replace('<div class="acts">', () => `<div class="acts">${answerActs(r, ui)}`).replace(/class="btn pri"( type="button" data-act="focus")/, 'class="btn"$1') : acts

/** 答えの欄: 選択肢の下の説明と、書いて答える欄（送るは枠のボタン）と、届かなかった理由。 */
export function answerHtml(r: VRow, ui: Ui): string {
  const way = answerWay(r)
  if (!way) return ''
  const k = keyOf(r)
  const ask = r.agent!.ask!
  const busy = busyOf(ui, k)
  const btn = btnOf(k, busy)
  const picks = way === 'keys' ? ask.choices ?? [] : way === 'reply' ? (ask.options ?? []).map((label, i) => ({ n: i, label, note: undefined })) : []
  const notes = picks.some((c) => c.note) ? `<ul class="anslist">${picks.map((c) => `<li><b>${esc(c.label)}</b>${c.note ? `<span class="mut">${esc(c.note)}</span>` : ''}</li>`).join('')}</ul>` : ''
  const writable = way !== 'keys' || !!ask.free
  const draft = ui.answerDraft?.[k] ?? ''
  const id = `ans-${k.replace(/[^\w-]/g, '_')}`
  const write = writable
    ? `<div class="ansin">${picks.length ? `<label class="lb" for="${esc(id)}">選択肢に無い答えを書く</label>` : ''}`
      + `<textarea id="${esc(id)}" data-ansdraft="${esc(k)}" rows="2" maxlength="${TEXT_MAX}"${picks.length ? '' : ` aria-label="${way === 'dispatch' ? '返事を書く' : '答えを書く'}"`}>${esc(draft)}</textarea>`
      + `<div class="ansgo">${btn('送る', `data-write="1"${draft.trim() ? '' : ' disabled'}`)}</div></div>`
    : ''
  const state = ui.answering?.[k]
  const note = state?.error ? `<p class="askfail" role="alert">${esc(state.error)}</p>` : busy ? '<p class="mut" role="status">送っています…</p>' : ''
  if (!notes && !write && !note) return ''
  return fld(`${way === 'keys' && ask.kind === 'permit' ? '許可' : '答える'}（${WHERE[way]}）`, `<div class="answer">${notes}${write}${note}</div>`)
}
