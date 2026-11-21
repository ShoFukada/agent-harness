// 操縦席の見た目。管制の運航票（flight strip）のボードに見立て、カードを期限の軸にぶら下げる。
// 目立たせるのは左の期限の軸だけにし、ほかは静かに保つ。外部のフォントは読み込まない（パネルは Orca のサンドボックス）。
export const CSS = `
.ck { color-scheme: light;
  --bg:#e9edf0; --surface:#ffffff; --sunk:#f3f5f7; --ink:#15212c; --ink2:#4b5966; --ink3:#7a8692; --rule:#d3dae0; --rule2:#e4e9ed;
  --focus:#1f5fbf; --hot:#cf3a1c; --hot-bg:#fdeee9; --ok:#2c7a4b;
  --k-inbox:#0e7c72; --k-send:#6a47c9; --k-decide:#1f3a68; --k-review:#0b6e99; --k-permit:#9a6200; --k-stuck:#39434d; --k-talk:#5a6b7d; --k-report:#6f7a84;
  --shadow:0 1px 0 rgba(21,33,44,.06), 0 1px 2px rgba(21,33,44,.06);
  --fs-xs:12px; --fs-s:13px; --fs-m:14px; --fs-l:16px; --fs-xl:20px; --fs-xxl:28px;
  font-family:"IBM Plex Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN",-apple-system,system-ui,sans-serif;
  font-size:var(--fs-m); line-height:1.65; font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased;
  background:var(--bg); color:var(--ink); min-height:100vh; container-type:inline-size; }
.ck[data-theme="dark"] { color-scheme: dark;
  --bg:#0e141a; --surface:#172029; --sunk:#121a21; --ink:#e4eaef; --ink2:#b1bdc8; --ink3:#94a1ad; --rule:#2a3641; --rule2:#212c36;
  --focus:#7fb0ff; --hot:#ff7a56; --hot-bg:#3a1d15; --ok:#6cc58f;
  --k-inbox:#3fc1b3; --k-send:#a68bff; --k-decide:#8fb0e8; --k-review:#4fb6e3; --k-permit:#e0a640; --k-stuck:#d3dbe3; --k-talk:#9fb0c2; --k-report:#98a3ad;
  --shadow:0 1px 0 rgba(0,0,0,.3); }
body { margin:0; }
.ck * { box-sizing:border-box; }
.ck button { font:inherit; color:inherit; cursor:pointer; }
.ck :focus-visible { outline:2px solid var(--focus); outline-offset:2px; }
.ck [hidden] { display:none !important; }
.ck .vh { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.ck .mut { color:var(--ink3); }
.ck .code { font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace; font-size:.92em; }

/* ── 上の帯 ── */
.ck .top { position:sticky; top:0; z-index:5; background:var(--bg); border-bottom:1px solid var(--rule);
  display:flex; flex-wrap:wrap; align-items:center; gap:8px 20px; padding:16px 20px; }
.ck .tally { display:flex; align-items:baseline; gap:10px; }
.ck .tally b { font-size:var(--fs-xxl); line-height:1; font-weight:700; letter-spacing:-.01em; }
.ck .tally span { font-size:var(--fs-s); color:var(--ink2); }
.ck .kinds { display:flex; flex-wrap:wrap; gap:4px 14px; font-size:var(--fs-s); color:var(--ink2); }
.ck .kinds .kc { display:inline-flex; align-items:center; gap:5px; }
.ck .kinds .kc b { color:var(--ink); font-weight:600; }
.ck .kinds .ref { color:var(--ink3); padding-left:14px; border-left:1px solid var(--rule); }
.ck .flags { margin-left:auto; display:flex; flex-wrap:wrap; gap:6px 14px; align-items:center; font-size:var(--fs-s); color:var(--ink2); }
.ck .flag { display:inline-flex; gap:6px; align-items:center; border:0; background:none; padding:2px 0; color:inherit; }
.ck .flag.warn { color:var(--k-permit); font-weight:600; text-decoration:underline; text-decoration-style:dotted; text-underline-offset:3px; }
.ck .flag.err { color:var(--hot); font-weight:600; }
.ck .seg { display:inline-flex; border:1px solid var(--rule); border-radius:6px; overflow:hidden; }
.ck .seg button { border:0; background:none; padding:1px 9px; font-size:var(--fs-xs); color:var(--ink2); }
.ck .seg button[aria-pressed="true"] { background:var(--ink); color:var(--surface); }

/* ── 3 つの列 ── */
.ck .board { display:grid; grid-template-columns:248px minmax(0,1fr) 360px; gap:0 20px; padding:16px 20px 80px; max-width:1560px; margin:0 auto; align-items:start; }
.ck .board.panel { grid-template-columns:minmax(0,1fr); padding:10px 12px 72px; }
.ck .paneswitch { display:none; position:sticky; top:0; z-index:4; gap:4px; padding:6px 12px; background:var(--bg); border-bottom:1px solid var(--rule); }
.ck .paneswitch button { flex:1; border:1px solid var(--rule); background:none; border-radius:7px; padding:4px 8px; font-size:var(--fs-s); font-weight:600; color:var(--ink2); }
.ck .paneswitch button[aria-selected="true"] { background:var(--surface); color:var(--ink); border-color:var(--ink3); }
.ck .paneswitch b { margin-left:6px; color:var(--hot); }
@container (max-width:1180px) { .ck .board { grid-template-columns:200px minmax(0,1fr); } .ck .board .side { grid-column:2; } }
@container (max-width:760px) { .ck .board { grid-template-columns:minmax(0,1fr); padding:10px 12px 72px; } .ck .board .side { grid-column:auto; }
  /* 狭い幅では上の帯を留めない（低い画面で本文の場所を取らないように）。 */
  .ck .top { position:static; padding:10px 12px; gap:6px 14px; } .ck .tally b { font-size:24px; } .ck .flags { margin-left:0; }
  .ck .paneswitch { display:flex; }
  .ck .board[data-pane="queue"] .side, .ck .board[data-pane="side"] .queue { display:none; } }

/* 案件の列。狭い窓ではチップの横並び。 */
.ck .cases { position:sticky; top:76px; display:grid; gap:2px; }
.ck .case { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:0 8px; align-items:center; text-align:left;
  border:0; background:none; padding:7px 10px; border-radius:6px; color:var(--ink2); }
.ck .case:hover { background:var(--rule2); }
.ck .case[aria-current="true"] { background:var(--surface); color:var(--ink); box-shadow:var(--shadow); }
.ck .case .nm { font-weight:600; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ck .case .n { font-weight:700; color:var(--ink); }
.ck .case .sub { grid-column:1 / -1; font-size:var(--fs-xs); color:var(--ink3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ck .case .here { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--focus); margin-left:6px; vertical-align:middle; }
.ck .case.zero .n { color:var(--ink3); font-weight:400; }
.ck .cases h3, .ck .side h3 { font-size:var(--fs-xs); font-weight:600; color:var(--ink3); margin:14px 10px 4px; letter-spacing:.02em; }
.ck .case .sub .hot { color:var(--hot); font-weight:600; }
@container (max-width:760px) {
  .ck .cases { position:static; display:flex; gap:6px; overflow-x:auto; padding-bottom:4px; scrollbar-width:none; }
  .ck .case { flex:none; grid-template-columns:auto auto; padding:4px 10px; border:1px solid var(--rule); border-radius:999px; }
  .ck .case .sub, .ck .cases h3 { display:none; }
}

/* ── 期限の軸と票 ── */
.ck .queue { min-width:0; }
.ck .lane { display:grid; grid-template-columns:88px minmax(0,1fr); gap:0 14px; }
.ck .lane + .lane { margin-top:6px; }
.ck .when { position:relative; text-align:right; padding-top:12px; font-size:var(--fs-s); font-weight:700; color:var(--ink2); }
.ck .when::after { content:""; position:absolute; right:-8px; top:0; bottom:-6px; width:2px; background:var(--rule); }
.ck .lane.over .when { color:var(--hot); }
.ck .lane.over .when::after, .ck .lane.today .when::after { background:var(--ink2); }
.ck .lane.over .when::after { background:var(--hot); }
.ck .lane.stuck .when { color:var(--k-stuck); }
.ck .lane.stuck .when::after { background:var(--k-stuck); }
.ck .when small { display:block; font-weight:400; font-size:var(--fs-xs); color:var(--ink3); }
.ck .now-line { grid-column:1 / -1; display:grid; grid-template-columns:88px minmax(0,1fr); gap:0 14px; align-items:center; margin:6px 0; }
.ck .now-line span { text-align:right; font-size:var(--fs-xs); font-weight:700; color:var(--focus); }
.ck .now-line i { height:2px; background:var(--focus); opacity:.55; border-radius:1px; }
/* 区分ごとに 1 つの面。票は区切り線で並べ、1 件ずつの囲みにしない。 */
.ck .strips { display:grid; margin:6px 0; min-width:0; background:var(--surface); border:1px solid var(--rule2); border-radius:8px; box-shadow:var(--shadow); overflow:hidden; }
@container (max-width:520px) { .ck .lane { grid-template-columns:minmax(0,1fr); } .ck .when { text-align:left; padding:10px 0 0; } .ck .when::after { display:none; }
  .ck .when small { display:inline; margin-left:6px; } .ck .now-line { grid-template-columns:auto minmax(0,1fr); }
  /* 狭い幅で案件名と仕事の名前が並ぶと、どちらも数文字に削られるので、案件名があるときは仕事の名前を出さない。 */
  .ck .strip .meta .ws ~ .jobname { display:none; } .ck .strip .ws { max-width:none; }
  .ck .due.hot .tm, .ck .flag.live, .ck .acts .hint { display:none; } }

.ck .strip { position:relative; min-width:0; }
.ck .strip + .strip { border-top:1px solid var(--rule2); }
.ck .strip[aria-expanded="true"] { box-shadow:inset 0 0 0 2px var(--kc); }
.ck .strip.hot { --hotline:var(--hot); }
.ck .strip .head { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:1px 12px; width:100%; text-align:left; border:0; background:none; padding:8px 14px; }
.ck .sp > .pt + .pt { margin-left:.9em; }
.ck .pl { font-weight:600; color:var(--ink2); margin-right:.6em; }
/* 種類・案件・仕事は 1 行に固定し、長い仕事の名前は末尾を省く（題の書き出しの位置をそろえる）。 */
.ck .strip .meta { display:flex; flex-wrap:nowrap; align-items:center; gap:2px 10px; font-size:var(--fs-xs); color:var(--ink3); min-width:0; white-space:nowrap; overflow:hidden; }
.ck .strip .meta > * { flex-shrink:0; }
.ck .strip .meta > :last-child:not(.kind) { flex-shrink:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.ck .strip .kind { display:inline-flex; align-items:center; gap:5px; color:var(--kc); font-weight:700; }
.ck .strip .ws { color:var(--ink2); font-weight:600; max-width:45%; overflow:hidden; text-overflow:ellipsis; }
.ck .strip .title { grid-column:1 / -1; font-size:var(--fs-l); font-weight:600; line-height:1.45; color:var(--ink); }
.ck .strip .due { grid-row:1; grid-column:2; align-self:start; text-align:right; font-size:var(--fs-s); font-weight:600; color:var(--ink2); white-space:nowrap; }
.ck .due.hot { color:var(--hot); }
.ck .due.hot b { display:inline-block; background:var(--hot); color:#fff; border-radius:4px; padding:0 6px; margin-right:4px; }
.ck .strip .peek { grid-column:1 / -1; font-size:var(--fs-s); color:var(--ink2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ck .strip[aria-expanded="true"] .peek { display:none; }
.ck .k-inbox { --kc:var(--k-inbox); } .ck .k-send { --kc:var(--k-send); } .ck .k-decide { --kc:var(--k-decide); } .ck .k-review { --kc:var(--k-review); }
.ck .k-permit { --kc:var(--k-permit); } .ck .k-stuck { --kc:var(--k-stuck); } .ck .k-talk { --kc:var(--k-talk); } .ck .k-report { --kc:var(--k-report); }
.ck .glyph { width:12px; height:12px; flex:none; color:var(--kc); }

/* 開いた票の中身 */
.ck .body { padding:0 16px 14px 14px; display:grid; gap:12px; min-width:0; }
.ck .purpose { font-size:var(--fs-s); color:var(--ink2); }
.ck .purpose b { color:var(--ink); font-weight:600; }
.ck .fld { display:grid; gap:2px; min-width:0; }
.ck .fld > .lb { font-size:var(--fs-xs); font-weight:600; color:var(--ink3); }
.ck .fld > div, .ck .fld > p { margin:0; overflow-wrap:anywhere; }
.ck .ctx { display:grid; grid-template-columns:9.5em minmax(0,1fr); gap:6px 14px; margin:0; font-size:var(--fs-s); }
.ck .ctx dt { color:var(--ink3); font-weight:600; }
.ck .ctx dd { margin:0; overflow-wrap:anywhere; }
@container (max-width:520px) { .ck .ctx { grid-template-columns:minmax(0,1fr); gap:0; } .ck .ctx dd { margin-bottom:6px; } }
.ck .rich ul { margin:2px 0; padding-left:1.2em; }
.ck .rich p { margin:0 0 4px; }
.ck .msg { border:1px solid var(--rule); border-radius:10px; background:var(--sunk); padding:10px 12px; white-space:pre-wrap; overflow-wrap:anywhere; font-size:var(--fs-s); max-height:22em; overflow:auto; }
.ck .msg-to { font-size:var(--fs-xs); color:var(--ink2); }
.ck .msg-to b { color:var(--ink); }
.ck .quote { border-left:3px solid var(--rule); padding:2px 0 2px 10px; color:var(--ink2); font-size:var(--fs-s); white-space:pre-wrap; overflow-wrap:anywhere; }
.ck .opts { display:grid; gap:6px; margin:0; padding:0; border:0; min-width:0; }
.ck .opt { display:grid; grid-template-columns:26px minmax(0,1fr); gap:0 10px; align-items:start; text-align:left; width:100%;
  border:1px solid var(--rule); border-radius:8px; background:var(--surface); padding:8px 12px 8px 8px; }
.ck .opt:hover { border-color:var(--ink3); }
.ck .opt[aria-checked="true"] { border-color:var(--kc); box-shadow:inset 0 0 0 1px var(--kc); }
.ck .opt .key { font-size:var(--fs-xs); font-weight:700; color:var(--ink3); border:1px solid var(--rule); border-radius:5px; height:22px; display:grid; place-items:center; }
.ck .opt[aria-checked="true"] .key { background:var(--kc); border-color:var(--kc); color:var(--surface); }
.ck .opt .lbl { font-weight:600; }
.ck .opt .rec { font-size:var(--fs-xs); font-weight:600; color:var(--ok); margin-left:6px; }
.ck .opt .ex { display:block; font-size:var(--fs-s); color:var(--ink2); }
.ck details.more { border-top:1px solid var(--rule2); padding-top:8px; }
.ck details.more summary { cursor:pointer; font-size:var(--fs-s); color:var(--ink2); font-weight:600; }
.ck details.more > div { display:grid; gap:10px; margin-top:8px; }
.ck .fig svg { max-width:100%; height:auto; }
.ck table.cmp { border-collapse:collapse; font-size:var(--fs-s); }
.ck table.cmp th, .ck table.cmp td { border:1px solid var(--rule); padding:4px 8px; text-align:left; vertical-align:top; }
.ck .tblwrap { overflow-x:auto; }
.ck .links { display:flex; flex-wrap:wrap; gap:6px; }
.ck .lk { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--rule); background:var(--surface); border-radius:6px; padding:1px 8px; font-size:var(--fs-s); color:var(--ink); max-width:100%; }
.ck .lk i { font-style:normal; font-size:var(--fs-xs); font-weight:700; color:var(--ink3); }
.ck .lk span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck a.inl, .ck button.inl { border:0; background:none; padding:0; color:var(--focus); text-decoration:underline; text-underline-offset:2px; }
.ck .owner { display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; font-size:var(--fs-xs); color:var(--ink3); }
.ck .owner b { color:var(--ink2); font-weight:600; }
.ck .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--ink3); }
.ck .dot.working { background:var(--ok); } .ck .dot.blocked, .ck .dot.waiting { background:var(--k-permit); }
.ck .done-list { display:grid; gap:6px; margin:0; padding:0; list-style:none; }
.ck .done-list li { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 10px; align-items:start; border-bottom:1px solid var(--rule2); padding-bottom:6px; }
.ck .done-list small { grid-column:1; color:var(--ink3); font-size:var(--fs-xs); }
.ck .other textarea { width:100%; min-height:5em; resize:vertical; font:inherit; font-size:var(--fs-s); border:1px solid var(--rule); border-radius:8px; padding:8px 10px; background:var(--surface); color:var(--ink); }
.ck .other .cnt { font-size:var(--fs-xs); color:var(--ink3); }

/* 返答の列。低い窓でも見えるよう、開いた票の下に留める。 */
.ck .acts { position:sticky; bottom:0; display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:10px 14px; margin:0 -16px -14px -14px;
  background:var(--surface); border-top:1px solid var(--rule2); border-radius:0 0 8px 8px; }
.ck .btn { border:1px solid var(--rule); background:var(--surface); border-radius:7px; padding:5px 12px; font-size:var(--fs-s); font-weight:600; color:var(--ink); }
.ck .btn:hover { border-color:var(--ink3); }
.ck .btn.pri { background:var(--ink); border-color:var(--ink); color:var(--surface); }
.ck .btn.pri:disabled { background:var(--rule); border-color:var(--rule); color:var(--ink3); cursor:default; }
.ck .btn.talk { border-color:var(--focus); color:var(--focus); }
.ck .btn.quiet { border-color:transparent; color:var(--ink2); font-weight:400; }
.ck .acts .hint { margin-left:auto; font-size:var(--fs-xs); color:var(--ink3); }
.ck kbd { font:inherit; font-size:var(--fs-xs); border:1px solid var(--rule); border-radius:4px; padding:0 4px; }

/* ── 右の列: 案件の今・話し中・顧客待ち・報告・片付いた ── */
/* 右の列は 1 つの面。区分は区切り線で分け、区分ごとの囲みにしない。 */
.ck .side { display:grid; align-content:start; min-width:0; background:var(--surface); border:1px solid var(--rule2); border-radius:10px; box-shadow:var(--shadow); }
.ck .pane { padding:12px 14px; min-width:0; }
.ck .pane + .pane { border-top:1px solid var(--rule); }
.ck .pane > h2 { margin:0 0 6px; font-size:var(--fs-m); font-weight:700; display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 8px; }
.ck .pane > h2 small { font-weight:400; color:var(--ink3); font-size:var(--fs-xs); white-space:nowrap; }
.ck .pane .src { font-size:var(--fs-xs); color:var(--focus); font-weight:600; }
.ck .ms { display:grid; gap:2px; margin:0 0 8px; padding:0; list-style:none; font-size:var(--fs-s); }
.ck .ms li { display:grid; grid-template-columns:4.5em minmax(0,1fr); gap:8px; }
.ck .ms b { color:var(--ink); }
.ck .jobs { display:grid; margin:0; padding:0; list-style:none; }
.ck .job { display:grid; grid-template-columns:12px minmax(0,1fr); gap:0 8px; padding:7px 0; border-top:1px solid var(--rule2); font-size:var(--fs-s); }
.ck .job .t { font-weight:600; color:var(--ink); }
.ck .job .st { grid-column:2; font-size:var(--fs-xs); font-weight:600; }
.ck .job .nx { grid-column:2; color:var(--ink2); font-size:var(--fs-xs); }
.ck .job.mine .st { color:var(--k-decide); } .ck .job.stopped .st { color:var(--k-stuck); } .ck .job.working .st { color:var(--ok); }
.ck .job.customer .st { color:var(--k-send); } .ck .job.idle .st, .ck .job.done .st { color:var(--ink3); }
.ck .js { grid-row:1 / span 3; width:10px; height:10px; margin-top:5px; border-radius:50%; border:2px solid currentColor; }
.ck .job.mine .js { color:var(--k-decide); background:currentColor; } .ck .job.stopped .js { color:var(--k-stuck); border-radius:2px; background:currentColor; }
.ck .job.working .js { color:var(--ok); } .ck .job.customer .js { color:var(--k-send); border-style:dashed; } .ck .job.idle .js, .ck .job.done .js { color:var(--ink3); }
.ck .mini { display:grid; margin:0; padding:0; list-style:none; }
.ck .mini li { border-top:1px solid var(--rule2); }
.ck .mini li:first-child { border-top:0; }
.ck .mini .row { display:grid; grid-template-columns:minmax(0,1fr); gap:1px; width:100%; text-align:left; border:0; background:none; padding:7px 0; font-size:var(--fs-s); }
.ck .mini .row:hover .t { text-decoration:underline; text-underline-offset:3px; }
.ck .mini .row .t { color:var(--ink); font-weight:600; overflow-wrap:anywhere; }
.ck .mini .row .t i { font-style:normal; font-weight:400; color:var(--ink3); }
.ck .mini .row small { color:var(--ink3); font-size:var(--fs-xs); }
.ck .mini .row .r { font-size:var(--fs-xs); color:var(--ink3); }
.ck .mini .row .r.recv { color:var(--ok); } .ck .mini .row .r.pend { color:var(--k-permit); font-weight:600; }
.ck .mini .row .r.hot { color:var(--hot); font-weight:700; }
.ck .mini .strip { margin:6px 0; }
.ck .pane details > summary { cursor:pointer; list-style:none; }
.ck .pane details > summary::-webkit-details-marker { display:none; }
.ck .pane details > summary h2 { margin:0; font-size:var(--fs-m); font-weight:700; display:flex; gap:8px; align-items:baseline; }
.ck .pane details > summary h2::before { content:"＋"; color:var(--ink3); font-weight:400; }
.ck .pane details[open] > summary h2::before { content:"－"; }

/* 空のとき・知らせ */
.ck .calm { display:grid; gap:6px; padding:40px 8px; text-align:left; }
.ck .calm b { font-size:var(--fs-xl); }
.ck .calm p { margin:0; color:var(--ink2); }
.ck .calm.warn b { color:var(--k-permit); }
.ck .notes { grid-column:1 / -1; display:grid; gap:4px; margin-bottom:12px; }
.ck .notes div { background:var(--surface); border:1px solid var(--rule); border-radius:6px; padding:6px 10px; font-size:var(--fs-s); color:var(--ink2); }
.ck .notes.warn { background:var(--surface); border:1px solid var(--rule); border-left:3px solid var(--k-permit); border-radius:6px; padding:8px 12px; gap:2px; font-size:var(--fs-s); }
.ck .notes.warn > b { color:var(--k-permit); }
.ck .notes.warn div { background:none; border:0; padding:0; }
.ck .flag.repeat { border:1px solid var(--rule); border-radius:6px; padding:1px 9px; font-size:var(--fs-xs); cursor:pointer; }
.ck .errs { grid-column:1 / -1; display:grid; gap:4px; margin-bottom:12px; }
.ck .errs div { background:var(--hot-bg); color:var(--hot); border-radius:6px; padding:6px 10px; font-size:var(--fs-s); font-weight:600; }
.ck .toasts { position:fixed; left:50%; bottom:max(16px, env(safe-area-inset-bottom)); transform:translateX(-50%); z-index:10; width:max-content; max-width:min(640px, calc(100vw - 24px)); display:grid; gap:6px; }
.ck .toast {
  display:flex; align-items:center; gap:12px; background:var(--ink); color:var(--surface); border-radius:10px; padding:10px 14px; font-size:var(--fs-s); box-shadow:0 8px 28px rgba(0,0,0,.25); }
.ck .toast button { border:1px solid currentColor; background:none; color:inherit; border-radius:6px; padding:2px 10px; font-weight:600; }
@media (prefers-reduced-motion:no-preference) {
  .ck .strip { transition:box-shadow .15s ease; }
  .ck .toast { animation:ck-up .18s ease-out; }
  @keyframes ck-up { from { transform:translateY(8px); opacity:0; } }
}
.ck svg text { font-family:inherit; }
`
