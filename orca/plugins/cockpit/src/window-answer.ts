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

export function answerHtml(r: VRow, ui: Ui): string {
  const way = answerWay(r)
  if (!way) return ''
  const k = keyOf(r)
  const ask = r.agent!.ask!
  const busy = !!ui.answering?.[k] && !ui.answering[k]!.error
  const btn = (label: string, attrs: string, cls = '') =>
    `<button class="btn${cls ? ` ${cls}` : ''}" type="button" data-act="answer" data-key="${esc(k)}" ${attrs}${busy ? ' disabled' : ''}>${esc(label)}</button>`
  const picks = way === 'keys'
    ? (ask.choices ?? []).map((c, i) => `<li>${btn(c.label, `data-choice="${c.n}"`, ask.kind === 'permit' && i === 0 ? 'pri' : '')}${c.note ? `<span class="mut">${esc(c.note)}</span>` : ''}</li>`)
    : way === 'reply' ? (ask.options ?? []).map((o, i) => `<li>${btn(o, `data-pick="${i}"`)}</li>`) : []
  const writable = way !== 'keys' || !!ask.free
  const draft = ui.answerDraft?.[k] ?? ''
  const id = `ans-${k.replace(/[^\w-]/g, '_')}`
  const write = writable
    ? `<div class="ansin">${picks.length ? `<label class="lb" for="${esc(id)}">選択肢に無い答えを書く</label>` : ''}`
      + `<textarea id="${esc(id)}" data-ansdraft="${esc(k)}" rows="2" maxlength="${TEXT_MAX}"${picks.length ? '' : ` aria-label="${way === 'dispatch' ? '返事を書く' : '答えを書く'}"`}>${esc(draft)}</textarea>`
      + `<div class="ansgo">${btn('送る', `data-write="1"${draft.trim() ? '' : ' disabled'}`, picks.length ? '' : 'pri')}</div></div>`
    : ''
  const state = ui.answering?.[k]
  const note = state?.error ? `<p class="askfail" role="alert">${esc(state.error)}</p>` : busy ? '<p class="mut" role="status">送っています…</p>' : ''
  return fld(`${way === 'keys' && ask.kind === 'permit' ? '許可' : '答える'}（${WHERE[way]}）`, `<div class="answer">${picks.length ? `<ul class="anspick">${picks.join('')}</ul>` : ''}${write}${note}</div>`)
}
