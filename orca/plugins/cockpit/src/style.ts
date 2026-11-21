// 操縦席の見た目。管制の運航票（flight strip）のボードに見立て、カードを期限の軸にぶら下げる。
// 目立たせるのは左の期限の軸だけにし、ほかは静かに保つ。外部のフォントは読み込まない（パネルは Orca のサンドボックス）。
export const CSS = `
.ck { color-scheme: light;
  --bg:#e9edf0; --surface:#ffffff; --sunk:#f3f5f7; --ink:#15212c; --ink2:#4b5966; --ink3:#7a8692; --rule:#d3dae0; --rule2:#e4e9ed;
  --focus:#1f5fbf; --hot:#cf3a1c; --hot-bg:#fdeee9; --ok:#2c7a4b;
  --k-inbox:#0e7c72; --k-send:#6a47c9; --k-decide:#1f3a68; --k-review:#0b6e99; --k-permit:#9a6200; --k-stuck:#39434d; --k-talk:#5a6b7d; --k-report:#6f7a84; --k-consult:#2f6f5e;
  --f-delegate:#2c56c9; --f-cowork:#a0670f; --f-watch:#0f7a6e; --amber:#9a6200; --amber-bg:#fbf1de; --ok-bg:#e6f3ea; --run:#5fa3e6; --run-bg:#e9f3fc; --mine:#1f3a68;
  --shadow:0 1px 0 rgba(21,33,44,.06), 0 1px 2px rgba(21,33,44,.06);
  --fs-xs:12px; --fs-s:13px; --fs-m:14px; --fs-l:16px; --fs-xl:20px; --fs-xxl:28px;
  font-family:"IBM Plex Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN",-apple-system,system-ui,sans-serif;
  font-size:var(--fs-m); line-height:1.65; font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased;
  /* 和欧の間隔は文字の空白でなく組版で付ける（R85。文の空白は tighten() が除く）。 */
  text-autospace:normal;
  background:var(--bg); color:var(--ink); min-height:100vh; container-type:inline-size; }
.ck[data-theme="dark"] { color-scheme: dark;
  --bg:#0e141a; --surface:#172029; --sunk:#121a21; --ink:#e4eaef; --ink2:#b1bdc8; --ink3:#94a1ad; --rule:#2a3641; --rule2:#212c36;
  --focus:#7fb0ff; --hot:#ff7a56; --hot-bg:#3a1d15; --ok:#6cc58f;
  --k-inbox:#3fc1b3; --k-send:#a68bff; --k-decide:#8fb0e8; --k-review:#4fb6e3; --k-permit:#e0a640; --k-stuck:#d3dbe3; --k-talk:#9fb0c2; --k-report:#98a3ad; --k-consult:#77bfb0;
  --f-delegate:#7d9cf0; --f-cowork:#e0a94a; --f-watch:#4fc3b2; --amber:#e0a640; --amber-bg:#3a2d14; --ok-bg:#183424; --run:#4f8fd0; --run-bg:#16283a; --mine:#a9c1ef;
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
  .ck .cases { position:static; display:flex; gap:6px; overflow-x:auto; padding-bottom:4px; scrollbar-width:none;
    -webkit-mask-image:linear-gradient(to right, #000 85%, transparent); mask-image:linear-gradient(to right, #000 85%, transparent); }
  .ck .strips .strip { scroll-margin-top:60px; }
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
.ck .strips { display:grid; margin:6px 0; min-width:0; background:var(--surface); border:1px solid var(--rule2); border-radius:8px; box-shadow:var(--shadow); overflow:clip; }
@container (max-width:520px) { .ck .lane { grid-template-columns:minmax(0,1fr); } .ck .when { text-align:left; padding:10px 0 0; } .ck .when::after { display:none; }
  .ck .when small { display:inline; margin-left:6px; } .ck .now-line { grid-template-columns:auto minmax(0,1fr); }
  /* 狭い幅で案件名と仕事の名前が並ぶと、どちらも数文字に削られるので、案件名があるときは仕事の名前を出さない。 */
  .ck .strip .meta .ws ~ .jobname { display:none; } .ck .strip .ws { max-width:none; }
  .ck .due.hot .tm, .ck .flag.live, .ck .acts .hint { display:none; } }

.ck .strip { position:relative; min-width:0; scroll-margin:84px 0 16px; }
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
.ck .k-permit { --kc:var(--k-permit); } .ck .k-stuck { --kc:var(--k-stuck); } .ck .k-talk { --kc:var(--k-talk); } .ck .k-report { --kc:var(--k-report); } .ck .k-consult { --kc:var(--k-consult); }
.ck .glyph { width:12px; height:12px; flex:none; color:var(--kc); }

/* 開いた票の中身 */
.ck .body { padding:0 16px 14px 14px; display:grid; gap:12px; min-width:0; }
.ck .purpose { font-size:var(--fs-s); color:var(--ink2); }
.ck .purpose b { color:var(--ink); font-weight:600; }
.ck .fld { display:grid; gap:2px; min-width:0; }
.ck .fld > .lb { font-size:var(--fs-xs); font-weight:600; color:var(--ink3); }
.ck .fld > div, .ck .fld > p { margin:0; overflow-wrap:anywhere; }
.ck .ctx { display:grid; grid-template-columns:11em minmax(0,1fr); gap:6px 14px; margin:0; font-size:var(--fs-s); }
.ck .ctx dt { color:var(--ink3); font-weight:600; }
.ck .ctx dd { margin:0; overflow-wrap:anywhere; }
@container (max-width:520px) { .ck .ctx { grid-template-columns:minmax(0,1fr); gap:0; } .ck .ctx dd { margin-bottom:6px; } }
.ck .rich ul { margin:2px 0; padding-left:1.2em; }
.ck .rich p { margin:0 0 4px; }
.ck .msg { border:1px solid var(--rule); border-radius:10px; background:var(--sunk); padding:10px 12px; white-space:pre-wrap; overflow-wrap:anywhere; font-size:var(--fs-s); max-height:22em; overflow:auto; }
.ck .msg-to { font-size:var(--fs-xs); color:var(--ink2); }
.ck .cmd { display:flex; gap:8px; align-items:flex-start; }
.ck .cmd pre { margin:0; flex:1; min-width:0; }
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
.ck .acts { position:sticky; bottom:0; display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:10px 14px; margin:0 -14px -12px -12px;
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
.ck .nw { white-space:nowrap; }
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

/* ══ 窓の 3 タブ（window-view.ts）。パネルの部品（.fld・.opt・.btn・.acts）は上の決まりを使う ══ */
/*
 * 窓の色と字の体系（R81）。色の役割は 地（--bg・--surface・--sunk）・文字（--ink）・補助の文字（--ink2・--ink3）・線（--rule・--rule2）・
 * 強調 1 色（--focus）・危険 1 色（--hot）と、仕事の 3 つの形（--f-delegate・--f-cowork・--f-watch）だけ。カードの種類は色で分けず語と印で示すので、
 * パネルと共有する種類・状態の色の変数を、窓の中では役割の色に寄せる。字の大きさは 12・14・16・20px の 4 段（12px 未満は使わない）。
 */
.ck.win {
  --k-inbox:var(--ink2); --k-send:var(--ink2); --k-decide:var(--ink2); --k-review:var(--ink2); --k-permit:var(--ink2); --k-stuck:var(--ink2); --k-talk:var(--ink2); --k-report:var(--ink2); --k-consult:var(--ink2);
  --ok:var(--ink2); --ok-bg:var(--sunk); --amber:var(--ink2); --amber-bg:var(--sunk); --run:var(--focus); --run-bg:var(--sunk); --mine:var(--ink);
  --fs-xs:12px; --fs-s:14px; --fs-m:14px; --fs-l:16px; --fs-xl:20px;
  height:100vh; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.ck.win .pad { padding:18px; }
.ck.win .hotc { color:var(--hot); }
.ck.win .wtop { display:flex; flex-wrap:wrap; align-items:center; gap:8px 20px; padding:10px 18px 0; border-bottom:1px solid var(--rule); background:var(--bg); }
.ck.win .pj { font-weight:700; font-size:var(--fs-l); padding-bottom:10px; }
.ck.win .tabs { display:flex; gap:2px; align-self:end; }
.ck.win .tabs button { border:0; background:none; padding:7px 14px 9px; font-size:var(--fs-m); color:var(--ink2); border-bottom:3px solid transparent; display:flex; gap:7px; align-items:center; }
.ck.win .tabs button[aria-selected="true"] { color:var(--ink); font-weight:700; border-bottom-color:var(--ink); }
.ck.win .tabs .n { font-size:var(--fs-xs); min-width:20px; text-align:center; border-radius:999px; padding:0 6px; background:var(--ink); color:var(--surface); font-weight:600; }
.ck.win .tabs .n.z { background:none; color:var(--ink3); font-weight:400; }
.ck.win .flags { padding-bottom:10px; }
.ck.win .flags .err { color:var(--hot); font-weight:600; }
.ck.win .werrs { display:grid; gap:2px; padding:6px 18px; background:var(--hot-bg); color:var(--hot); font-size:var(--fs-s); border-bottom:1px solid var(--rule); }
.ck.win .wnotes { padding:5px 18px; font-size:var(--fs-s); color:var(--ink2); border-bottom:1px solid var(--rule); background:var(--sunk); }
.ck.win .wnotes summary { cursor:pointer; }
.ck.win .wnotes div { font-size:var(--fs-xs); padding-left:1.2em; }
.ck.win .wbody { display:grid; flex:1; min-height:0; }
.ck.win .wbody.split { grid-template-columns:minmax(0,1fr) minmax(420px,44%); }
/* 全体は右の「済んでいない依頼」を狭い幅でも隠さない（下に押し出さない）。R81 */
.ck.win .wbody.whole { grid-template-columns:minmax(0,1fr) clamp(280px, 32%, 400px); }
.ck.win .wpane { overflow-y:auto; padding:14px 18px 80px; display:grid; align-content:start; gap:14px; min-height:0; min-width:0; }
.ck.win .wside { overflow-y:auto; border-left:1px solid var(--rule); background:var(--surface); min-height:0; min-width:0; }
.ck.win .wpane > p { margin:0; font-size:var(--fs-s); }
.ck.win .calm { padding:24px 4px; }
@media (max-width:900px) {
  .ck.win .wbody.split { grid-template-columns:minmax(0,1fr) minmax(320px,46%); } }
@media (max-width:640px) {
  .ck.win { height:auto; overflow:visible; }
  .ck.win .wbody.split, .ck.win .wbody.whole { grid-template-columns:minmax(0,1fr); }
  .ck.win .wside { border-left:0; border-top:1px solid var(--rule); }
  .ck.win .wpane { padding-bottom:20px; } }

/* 要対応・対応済み: 仕事のまとまりと行 */
.ck.win .sgrp { display:grid; gap:6px; }
.ck.win .gh { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:center; font-size:var(--fs-s); padding:2px 2px 0; }
.ck.win .gh .prog { margin-left:auto; }
.ck.win .gh b { font-size:var(--fs-m); }
.ck.win .gh .mut { font-size:var(--fs-xs); }
.ck.win .subh { font-size:var(--fs-xs); color:var(--ink3); font-weight:600; }
/* 一覧は 1 つの枠に区切り線で並べる（1 件ずつ角丸の箱にしない）。種類は印と名前の色で示し、左端の色の線は使わない。 */
.ck.win .rows { display:grid; background:var(--surface); border:1px solid var(--rule); border-radius:8px; overflow:clip; }
.ck.win .cardrow { display:grid; grid-template-columns:92px minmax(0,1fr) auto; gap:10px; align-items:center; border:0; border-radius:0; padding:8px 12px; background:var(--surface); text-align:left; width:100%; }
.ck.win .cardrow + .cardrow { border-top:1px solid var(--rule2); }
.ck.win .cardrow:hover { background:var(--sunk); }
.ck.win .cardrow[aria-current="true"] { background:var(--sunk); box-shadow:inset 0 0 0 2px var(--focus); }
.ck.win .cardrow.cl .ti, .ck.win .cardrow.cl .kd { color:var(--ink2); font-weight:400; }
.ck.win .cardrow.cl .glyph { color:var(--ink3); }
.ck.win .kd { display:inline-flex; align-items:center; gap:5px; font-size:var(--fs-xs); font-weight:700; color:var(--kc); white-space:nowrap; }
.ck.win .cardrow .kd { display:grid; grid-template-columns:auto 1fr; }
.ck.win .cardrow .kd small { grid-column:1 / -1; font-weight:400; color:var(--ink3); }
.ck.win .cardrow .tt { min-width:0; }
.ck.win .cardrow .tl { display:flex; align-items:center; gap:6px; min-width:0; }
.ck.win .cardrow .tl .ti { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.ck.win .cardrow .tl .tag { flex:none; }
.ck.win .cardrow .crumb { display:block; font-size:var(--fs-xs); color:var(--ink3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck.win .cardrow .du { font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; text-align:right; display:grid; justify-items:end; }
.ck.win .cardrow .du.cl { white-space:normal; max-width:220px; }
.ck.win .cardrow .du .hot { color:var(--hot); font-weight:600; }
.ck.win .tag { display:inline-block; font-size:var(--fs-xs); font-weight:400; padding:0 6px; border-radius:4px; background:var(--sunk); color:var(--ink2); border:1px solid var(--rule2); white-space:nowrap; }
.ck.win .tag.wait { background:var(--amber-bg); color:var(--amber); border-color:transparent; }
.ck.win .tag.talk { background:var(--focus); color:var(--surface); border-color:transparent; }
.ck.win .tag.miss { background:var(--hot-bg); color:var(--hot); border-color:transparent; }
.ck.win .gaps { border:1px solid var(--hot); border-radius:8px; background:var(--surface); padding:8px 12px; font-size:var(--fs-s); display:grid; gap:2px; }
.ck.win .gaps b { color:var(--hot); }
.ck.win .gaps ul { margin:4px 0 0; padding-left:1.2em; }

/* 詳細（要対応・対応済みの右） */
.ck.win .wdet { display:grid; align-content:start; min-height:100%; }
.ck.win .dh { padding:14px 18px 12px; border-bottom:1px solid var(--rule2); display:grid; gap:6px; position:sticky; top:0; background:var(--surface); z-index:1; }
.ck.win .dh .crumbs { font-size:var(--fs-xs); color:var(--ink3); display:flex; gap:6px; flex-wrap:wrap; }
.ck.win .dh .crumbs i { font-style:normal; }
.ck.win .dh .kl { display:flex; gap:10px; align-items:center; font-size:var(--fs-xs); flex-wrap:wrap; }
.ck.win .dh h2 { margin:0; font-size:var(--fs-l); line-height:1.5; }
.ck.win .note { margin:10px 18px 0; padding:8px 10px; border-radius:6px; background:var(--sunk); font-size:var(--fs-s); }
.ck.win .note.wait { background:var(--amber-bg); } .ck.win .note.wait b { color:var(--amber); }
.ck.win .note.ok { background:var(--ok-bg); } .ck.win .note.ok b { color:var(--ok); }
.ck.win .first { margin:12px 18px 0; padding:12px; border:1px solid var(--rule); border-radius:8px; display:grid; gap:12px; font-size:var(--fs-s); }
.ck.win .first ol.rich, .ck.win .first ul.rich { margin:0; padding-left:1.4em; }
.ck.win details.more-d { margin:8px 18px 0; }
.ck.win details.more-d summary { cursor:pointer; font-size:var(--fs-s); color:var(--focus); padding:6px 0; }
.ck.win details.more-d .slots { display:grid; gap:10px; padding:4px 0 8px; font-size:var(--fs-s); }
.ck.win .wdet > .other { margin:8px 18px 0; }
.ck.win .dbtn { margin-top:auto; position:sticky; bottom:0; background:var(--surface); }
.ck.win .dbtn .acts { position:static; margin:0; border-radius:0; padding:12px 18px; }
.ck.win .dbtn .nx { margin-left:auto; }

/* 全体: 形ごとの置き場所と仕事の箱 */
.ck.win .f-delegate { --fc:var(--f-delegate); } .ck.win .f-cowork { --fc:var(--f-cowork); } .ck.win .f-watch { --fc:var(--f-watch); }
.ck.win .fm { display:inline-flex; align-items:center; gap:5px; font-size:var(--fs-xs); font-weight:700; color:var(--fc); white-space:nowrap; }
.ck.win .fm::before { content:""; width:10px; height:10px; border-radius:2px; background:var(--fc); }
.ck.win .fsec { display:grid; gap:10px; }
.ck.win .fsec > h3 { margin:6px 0 0; font-size:var(--fs-m); display:flex; gap:10px; align-items:baseline; }
.ck.win .fsec > h3 .mut { font-weight:400; font-size:var(--fs-xs); }
.ck.win .fsec > p { margin:0; font-size:var(--fs-s); }
.ck.win .st { background:var(--surface); border:1px solid var(--rule); border-radius:8px; }
.ck.win .st > .sh { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px 16px; padding:11px 14px; }
.ck.win .st .t { font-weight:600; font-size:var(--fs-l); display:flex; gap:10px; align-items:center; flex-wrap:wrap; border:0; background:none; padding:0; text-align:left; }
.ck.win .st .tw { font-size:var(--fs-xs); color:var(--ink3); font-weight:400; }
.ck.win .st .right { display:flex; align-items:center; gap:10px; }
.ck.win .st .meta { grid-column:1 / -1; display:flex; gap:6px 16px; flex-wrap:wrap; font-size:var(--fs-s); color:var(--ink2); align-items:center; }
.ck.win .st .nxt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:60ch; }
/* 工程の進み（工程 n/5）。済んだ段は補助の文字色で塗り、今の段は墨で長く、まだの段は枠だけ。 */
.ck.win .pbar { display:inline-flex; gap:8px; align-items:center; font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; }
.ck.win .pps { display:inline-flex; gap:2px; }
.ck.win .pp { display:block; width:12px; height:6px; border:1px solid var(--ink3); border-radius:1px; }
.ck.win .pp.on { background:var(--ink3); }
.ck.win .pp.cur { width:20px; background:var(--ink); border-color:var(--ink); }
.ck.win .ppn { min-width:9.5em; }
.ck.win .prog { display:inline-flex; align-items:center; gap:8px; font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; }
.ck.win .pill { display:inline-flex; align-items:center; font-size:var(--fs-xs); font-weight:600; border-radius:999px; padding:1px 9px; white-space:nowrap; }
.ck.win .pill.mine { background:var(--mine); color:var(--surface); }
.ck.win .pill.stopped { background:var(--hot); color:var(--surface); }
.ck.win .pill.working { background:var(--run-bg); color:var(--focus); border:1px solid var(--run); }
.ck.win .pill.customer { background:var(--amber-bg); color:var(--amber); }
.ck.win .pill.idle { background:var(--sunk); color:var(--ink2); border:1px solid var(--rule); }
.ck.win .pill.done { background:var(--ok-bg); color:var(--ok); }
.ck.win .st .inner { border-top:1px solid var(--rule2); padding:4px 14px 12px; display:grid; gap:2px; }
.ck.win .phase { font-size:var(--fs-xs); color:var(--ink3); font-weight:600; letter-spacing:.04em; padding:8px 0 2px; display:flex; gap:8px; align-items:center; }
.ck.win .task { display:grid; grid-template-columns:4.5em minmax(0,1fr) auto; gap:8px; align-items:start; padding:3px 0; font-size:var(--fs-s); }
.ck.win .tst { font-size:var(--fs-xs); color:var(--ink2); padding-top:2px; white-space:nowrap; }
.ck.win .tst.s-run { color:var(--focus); font-weight:600; } .ck.win .tst.s-stop { color:var(--hot); font-weight:600; }
.ck.win .task .tn { display:grid; min-width:0; }
.ck.win .cardrow .kd small, .ck.win .task .id, .ck.win .rid { font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace; }
.ck.win .task .id { color:var(--ink3); font-size:var(--fs-xs); margin-right:6px; }
.ck.win .task .nx { color:var(--ink3); font-size:var(--fs-xs); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck.win .task .wk { display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
.ck.win .wrow { grid-column:2 / -1; display:flex; gap:8px; align-items:center; font-size:var(--fs-xs); color:var(--ink2); border-left:2px solid var(--run); padding:2px 0 2px 10px; margin:2px 0 4px; flex-wrap:wrap; }
.ck.win .wrow .wn { font-weight:600; color:var(--ink); }
.ck.win .chip { display:inline-flex; gap:4px; align-items:center; font-size:var(--fs-xs); border:1px solid var(--rule); border-radius:5px; padding:0 6px; background:var(--sunk); color:var(--ink2); white-space:nowrap; }
.ck.win .chip.live { border-color:var(--run); color:var(--focus); background:var(--run-bg); }
.ck.win .chip.bad { border-color:var(--hot); color:var(--hot); background:var(--hot-bg); }
.ck.win .chip.kc { border-color:var(--kc); color:var(--kc); background:var(--surface); font-weight:700; }
.ck.win .act { border:1px solid var(--rule); background:var(--surface); border-radius:5px; padding:0 8px; font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; line-height:1.9; }
.ck.win .act:hover { border-color:var(--ink3); color:var(--ink); }
.ck.win .act.talk { border-color:var(--focus); color:var(--focus); }
/* タスクの行の「話す」は、行に触れたときだけ出す（全部の行に同じボタンが並ぶと、読む行の頭が埋もれる）。 */
.ck.win .task .act.talk { visibility:hidden; }
.ck.win .task:hover .act.talk, .ck.win .task:focus-within .act.talk { visibility:visible; }
.ck.win .donebox { font-size:var(--fs-xs); color:var(--ink3); padding:4px 0 0 22px; }
.ck.win .wmore { border:0; background:none; color:var(--focus); font-size:var(--fs-s); padding:2px 0; text-align:left; justify-self:start; }
.ck.win .watch { display:grid; gap:6px; }
.ck.win .watch ul { margin:0; padding-left:1.2em; font-size:var(--fs-s); }
.ck.win .watch p { margin:0; font-size:var(--fs-s); }
.ck.win .watch .strips { margin:0; }

/* 全体の右: まだ済んでいない依頼 */
.ck.win .wside > h3 { margin:0; font-size:var(--fs-s); padding:12px 14px 6px; display:flex; gap:8px; align-items:baseline; }
.ck.win .wside > h3 .mut { font-weight:400; font-size:var(--fs-xs); }
.ck.win .wside > .note { font-size:var(--fs-xs); color:var(--ink3); padding:0 14px 8px; margin:0; background:none; }
.ck.win .rq { border-top:1px solid var(--rule2); }
.ck.win .rq > button { display:grid; grid-template-columns:36px minmax(0,1fr); gap:2px 6px; width:100%; text-align:left; border:0; background:none; padding:6px 14px; font-size:var(--fs-s); line-height:1.5; }
.ck.win .rq > button:hover { background:var(--sunk); }
.ck.win .rq .rid { color:var(--ink3); font-size:var(--fs-xs); padding-top:2px; }
.ck.win .rq .rt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck.win .rq .rs { grid-column:2; font-size:var(--fs-xs); color:var(--ink3); display:flex; gap:6px; flex-wrap:wrap; }
.ck.win .trace { padding:2px 14px 12px 60px; display:grid; gap:4px; font-size:var(--fs-xs); }
.ck.win .trace .q { white-space:pre-line; color:var(--ink2); border-left:2px solid var(--rule); padding-left:8px; overflow-wrap:anywhere; }
.ck.win .trace .l { color:var(--ink3); font-weight:600; margin-top:4px; }
`
