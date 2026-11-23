import { esc, type Ui } from './view.ts'

export const tag = (text: string, cls = '') => `<span class="tag${cls ? ` ${cls}` : ''}">${esc(text)}</span>`

export const fold = (ui: Ui, key: string, summary: string, body: string) =>
  `<details class="cont" data-fold="${esc(key)}"${ui.open[key] ? ' open' : ''}><summary>${summary}</summary>${body}</details>`
