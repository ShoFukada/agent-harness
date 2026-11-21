import type { CockpitView, WindowView, WsRow } from './protocol.ts'
import { countsHtml, dueHtml, esc, render, type Ui } from './view.ts'

const OK = '<span class="s-ok" aria-hidden="true">✓</span>'
const STOP = '<span class="st s-stop" aria-hidden="true">■</span>'
const idle = (r: WsRow) => !r.open && !r.stopped

function row(r: WsRow, selected: string | undefined, focused: string | undefined, now: number): string {
  const cur = r.root === selected
  const meta = [
    r.open ? `<span class="wdec">${countsHtml(r.counts)}</span>${r.due ? `<span class="wdue num">${dueHtml(r.due, now)}</span>` : ''}` : '',
    r.stopped ? `<span class="stopn">${STOP}止まっている worker <b class="num">${r.stopped}</b> 件</span>` : '',
  ].filter(Boolean)
  return `<button class="wsrow" data-ws="${esc(r.root)}" aria-current="${cur}">
    <span class="wn"><b>${esc(r.name)}</b>${r.root === focused ? '<span class="orca">Orca で表示中</span>' : ''}</span>
    ${meta.length ? `<span class="wm">${meta.join('')}</span>` : ''}
  </button>`
}

/** 全案件の合計（要対応・止まっている worker）。件数はここと左の列にだけ出す。 */
function yourTurn(w: WindowView): string {
  const sum = (k: 'dec' | 'ask' | 'rev') => w.rows.reduce((n, r) => n + r.counts[k], 0)
  const counts = { dec: sum('dec'), ask: sum('ask'), rev: sum('rev') }
  const stopped = w.rows.reduce((n, r) => n + r.stopped, 0)
  if (!counts.dec && !counts.ask && !counts.rev && !stopped) return `<span class="turn">${OK} 全案件 要対応なし</span>`
  return `<span class="turn"><span class="tcount">${countsHtml(counts)}</span>${stopped ? `<span class="stopn">${STOP}止まっている worker <b class="num">${stopped}</b> 件</span>` : ''}</span>`
}

export function renderWindow(w: WindowView | null, v: CockpitView | null, ui: Ui, now: number, svg: (raw: string) => string): string {
  if (!w) return `<div class="empty mut">読み込み中</div>`
  const selected = v?.root
  const top = `<header class="wtop">
    ${yourTurn(w)}
    <span class="wtools">
      ${w.errors.map((e) => `<span class="werr">${esc(e)}</span>`).join('')}
      <span class="mode">${w.mode === 'follow' ? '<span class="dot on" aria-hidden="true">●</span>Orca に合わせて表示' : '<span class="dot" aria-hidden="true">○</span>固定中'}</span>
      ${w.mode === 'manual' ? '<button class="btn sm" data-follow>Orca に合わせる</button>' : ''}
      ${selected && selected !== w.focused ? '<button class="btn sm" data-activate>Orca で開く</button>' : ''}
    </span>
  </header>`
  // 要対応なし案件は列の下に畳む。選んでいる行だけは畳まずに見せる。
  const shown = w.rows.filter((r) => !idle(r) || r.root === selected)
  const folded = w.rows.filter((r) => idle(r) && r.root !== selected)
  const rows = shown.map((r) => row(r, selected, w.focused, now)).join('')
  const fold = folded.length
    ? `<button class="wfold" data-idle aria-expanded="${!!ui.showIdle}">${OK} 要対応なし <b class="num">${folded.length}</b> 件</button>${ui.showIdle ? folded.map((r) => row(r, selected, w.focused, now)).join('') : ''}`
    : ''
  return `${top}<div class="wcols">
    <nav class="wlist" aria-label="ワークスペース">${rows + fold || '<div class="wnone mut">操縦席のあるワークスペース 0 件</div>'}</nav>
    <main class="wmain">${render(v, ui, now, svg, true)}</main>
  </div>`
}

export const WINDOW_CSS = `
html, body { height:100%; }
.ck { height:100vh; display:grid; grid-template-rows:auto 1fr; }
/* 全案件（上の帯と左の列）は薄い地、この案件の残りと選んだ項目は白地にして、3 つの領域を分ける。 */
.ck .wtop { display:flex; gap:6px 20px; align-items:center; flex-wrap:nowrap; padding:9px 18px; border-bottom:1px solid var(--line-strong); background:var(--paper2); }
.ck .wtop .turn { font-weight:700; display:inline-flex; gap:6px 14px; align-items:baseline; flex-wrap:wrap; }
.ck .wtop .stopn { color:var(--stop); display:inline-flex; gap:4px; align-items:center; }
/* 上の帯は 1 行に収める（低い窓で本文の高さを残す）。 */
.ck .wtop .turn, .ck .wtools { flex:none; }
.ck .wtools { margin-left:auto; display:flex; gap:6px 14px; align-items:center; flex-wrap:wrap; font-size:var(--fs-note); }
.ck .wtop .dot { margin-right:5px; } .ck .wtop .dot.on { color:var(--run); }
.ck .werr { color:var(--stop); }
.ck .wcols { display:grid; grid-template-columns:minmax(240px,300px) 1fr; min-height:0; }
.ck .wlist { border-right:1px solid var(--line-strong); overflow-y:auto; background:var(--paper2); }
.ck .wmain { min-width:0; min-height:0; container-type:inline-size; position:relative; display:flex; flex-direction:column; overflow:hidden; }
/* 要対応と対応済みは、一覧と詳細の欄だけを動かし、返答のボタンを詳細の下端に留める。全体のタブは 1 列なので画面ごと動かす。 */
.ck .wmain > .split { flex:1; min-height:0; }
.ck .wmain > .split > .list, .ck .wmain > .split > .detail { overflow-y:auto; min-height:0; }
.ck .wmain .detail .acts { position:sticky; bottom:0; background:var(--ck-background); padding:10px 0 12px; border-top:1px solid var(--ck-border); z-index:1; }
.ck .wmain > .split > .detail { padding:12px 24px 0; }
.ck .wmain .detail .sec { margin-top:10px; }
.ck .wmain .detail .ctxbody > .sec { margin-top:0; }
.ck .wmain .detail .opt { padding:5px 12px; margin-top:5px; }
.ck .wmain .detail h2 { margin:2px 0 0; }
.ck .wmain .detail .goal { margin-top:4px; }
.ck .wmain .detail .morebox { margin-top:10px; }
/* 高さ 500px 前後の窓では、見出しと余白を詰め、送る文面の枠を低くして、選択肢と返答のボタンを画面に残す。 */
/* 背の高い窓では送る文面を全文出す（枠の中で切れて続きに気付けないため）。 */
@media (min-height:901px) { .ck .wmain .detail .dtext { max-height:none; } }
/* 話したいの入力欄を開いたとき、下に留めた返答の列に隠れない位置まで動かす。 */
.ck .wmain .detail .chatin { scroll-margin-bottom:90px; }
@media (max-height:640px) {
  .ck .wmain .detail .dtext { max-height:7.5em; }
  .ck .wmain .detail h2 { font-size:var(--fs-head); }
  .ck .wmain .detail .sec { margin-top:6px; }
  .ck .wmain .detail .acts { padding:6px 0 8px; }
}
.ck .wmain:has(.whole-top) { display:block; overflow-y:auto; }
.ck .wmain .bar { display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 16px; padding:8px 18px; }
.ck .wsrow { display:grid; gap:2px; width:100%; text-align:left; background:none; border:0; border-bottom:1px solid var(--ck-border); border-left:3px solid transparent; padding:10px 14px; }
.ck .wsrow:hover { background:var(--ck-secondary); }
.ck .wsrow[aria-current="true"] { background:var(--ck-background); border-left-color:var(--line-strong); }
.ck .wsrow .wn { display:flex; gap:4px 8px; align-items:baseline; flex-wrap:wrap; }
.ck .wsrow .orca { font-size:var(--fs-note); color:var(--run); white-space:nowrap; }
.ck .wsrow .orca::before { content:"● "; }
.ck .wsrow .wm { display:flex; gap:2px 12px; flex-wrap:wrap; align-items:baseline; font-size:var(--fs-note); }
/* 件数と期限は語の途中で折らない。収まらなければ塊ごと次の行に送る。 */
.ck .wsrow .wdec .brk, .ck .wsrow .wdue, .ck .wsrow .stopn, .ck .wsrow .wm > span { white-space:nowrap; }
.ck .wsrow .wm > .wdec { white-space:normal; }
.ck .wsrow .wdec { font-weight:600; }
.ck .wsrow .stopn { color:var(--stop); font-weight:600; display:inline-flex; gap:4px; align-items:center; }
.ck .wfold { display:block; width:100%; text-align:left; background:none; border:0; border-bottom:1px solid var(--ck-border); padding:10px 14px; font-size:var(--fs-note); color:var(--ck-muted-foreground); }
.ck .wfold:hover { background:var(--ck-secondary); }
.ck .wnone { padding:16px 14px; font-size:var(--fs-note); }
.ck .wmain .split { min-height:0; }
@media (max-width:720px) {
  .ck .wtop { flex-wrap:wrap; }
  .ck .wcols { grid-template-columns:1fr; grid-template-rows:auto 1fr; }
  .ck .wlist { display:flex; overflow-x:auto; overflow-y:hidden; border-right:0; border-bottom:1px solid var(--line-strong); }
  .ck .wsrow { min-width:220px; align-content:start; border-left:0; border-bottom:0; border-right:1px solid var(--ck-border); }
  .ck .wsrow[aria-current="true"] { box-shadow:inset 0 -3px 0 var(--line-strong); }
  .ck .wsrow .wn b { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ck .wfold { width:auto; min-width:170px; border-bottom:0; border-right:1px solid var(--ck-border); }
}
`
