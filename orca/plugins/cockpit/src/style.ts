// 操縦席の見た目。管制の運航票（flight strip）のボードに見立て、カードを期限の軸にぶら下げる。
// 目立たせるのは左の期限の軸だけにし、ほかは静かに保つ。外部のフォントは読み込まない（パネルは Orca のサンドボックス）。
export const CSS = `
.ck { color-scheme: light;
  --bg:#e9edf0; --surface:#ffffff; --sunk:#f3f5f7; --ink:#15212c; --ink2:#4b5966; --ink3:#616b76; --rule:#d3dae0; --rule2:#e4e9ed;
  --focus:#1f5fbf; --hot:#c2361a; --hot-bg:#fdeee9; --ok:#2b7649;
  --k-inbox:#0d756c; --k-send:#6a47c9; --k-decide:#1f3a68; --k-review:#0b6e99; --k-permit:#925d00; --k-stuck:#39434d; --k-talk:#5a6b7d; --k-report:#616b73; --k-consult:#2f6f5e;
  --f-delegate:#2c56c9; --f-cowork:#925e0e; --f-watch:#0e756a; --amber:#925d00; --amber-bg:#fbf1de; --ok-bg:#e6f3ea; --run:#5fa3e6; --run-bg:#e9f3fc; --mine:#1f3a68;
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
.ck .seg { display:inline-flex; border:1px solid var(--ink3); border-radius:6px; overflow:hidden; }
.ck .seg button { border:0; background:none; padding:1px 9px; font-size:var(--fs-xs); color:var(--ink2); }
.ck .seg button[aria-pressed="true"] { background:var(--ink); color:var(--surface); }

/* ── 3 つの列 ── */
.ck .board { display:grid; grid-template-columns:248px minmax(0,1fr) 360px; gap:0 20px; padding:16px 20px 80px; max-width:1560px; margin:0 auto; align-items:start; }
.ck .board.panel { grid-template-columns:minmax(0,1fr); padding:10px 12px 72px; }
.ck .paneswitch { display:none; position:sticky; top:0; z-index:4; gap:4px; padding:6px 12px; background:var(--bg); border-bottom:1px solid var(--rule); }
.ck .paneswitch button { flex:1; border:1px solid var(--ink3); background:none; border-radius:7px; padding:4px 8px; font-size:var(--fs-s); font-weight:600; color:var(--ink2); }
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
.ck .case[aria-current="true"] { background:var(--surface); color:var(--ink); box-shadow:inset 3px 0 0 var(--focus); }
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
/* 票は区切り線で並べ、囲みの箱にしない（R111）。 */
.ck .strips { display:grid; margin:6px 0; min-width:0; border-block:1px solid var(--rule); }
/* 票は地の上に線で区切って並べ、開いた票だけ面の色で浮かせる（白い箱を並べない。追加 22）。 */
.ck .strip[aria-expanded="true"] { background:var(--surface); }
@container (max-width:520px) { .ck .lane { grid-template-columns:minmax(0,1fr); } .ck .when { text-align:left; padding:10px 0 0; } .ck .when::after { display:none; }
  .ck .when small { display:inline; margin-left:6px; } .ck .now-line { grid-template-columns:auto minmax(0,1fr); }
  /* 狭い幅で案件名と仕事の名前が並ぶと、どちらも数文字に削られるので、案件名があるときは仕事の名前を出さない。 */
  .ck .strip .meta .ws ~ .jobname { display:none; } .ck .strip .ws { max-width:none; }
  .ck .due.hot .tm, .ck .flag.live, .ck .acts .hint { display:none; } }

.ck .strip { position:relative; min-width:0; scroll-margin:84px 0 16px; }
.ck .strip + .strip { border-top:1px solid var(--rule2); }
.ck .strip[aria-expanded="true"] { box-shadow:inset 3px 0 0 var(--focus); }
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
  border:1px solid var(--ink3); border-radius:8px; background:var(--surface); padding:8px 12px 8px 8px; }
.ck .opt:hover { border-color:var(--ink); }
.ck .opt[aria-checked="true"] { border-color:var(--kc); box-shadow:inset 0 0 0 1px var(--kc); }
.ck .opt .key { font-size:var(--fs-xs); font-weight:700; color:var(--ink3); border:1px solid var(--ink3); border-radius:5px; height:22px; display:grid; place-items:center; }
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
.ck .lk { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--ink3); background:var(--surface); border-radius:6px; padding:1px 8px; font-size:var(--fs-s); color:var(--ink); max-width:100%; }
.ck .lk i { font-style:normal; font-size:var(--fs-xs); font-weight:700; color:var(--ink3); }
.ck .lk span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck a.inl, .ck button.inl { border:0; background:none; padding:0; color:var(--focus); text-decoration:underline; text-underline-offset:2px; }
.ck .owner { display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; font-size:var(--fs-xs); color:var(--ink3); }
.ck .owner b { color:var(--ink2); font-weight:600; }
.ck .done-list { display:grid; gap:6px; margin:0; padding:0; list-style:none; }
.ck .done-list li { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 10px; align-items:start; border-bottom:1px solid var(--rule2); padding-bottom:6px; }
.ck .done-list small { grid-column:1; color:var(--ink3); font-size:var(--fs-xs); }
.ck .other textarea { width:100%; field-sizing:content; min-height:calc(6lh + 18px); max-height:50vh; resize:vertical; font:inherit; font-size:var(--fs-s); line-height:1.6; border:1px solid var(--rule); border-radius:8px; padding:8px 10px; background:var(--surface); color:var(--ink); }
.ck .other .cnt { font-size:var(--fs-xs); color:var(--ink3); }

/* 返答の列。低い窓でも見えるよう、開いた票の下に留める。 */
.ck .acts { position:sticky; bottom:0; display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:10px 14px; margin:0 -14px -12px -12px;
  background:var(--surface); border-top:1px solid var(--rule2); border-radius:0 0 8px 8px; }
.ck .btn { white-space:nowrap; border:1px solid var(--ink3); background:var(--surface); border-radius:7px; padding:5px 12px; font-size:var(--fs-s); font-weight:600; color:var(--ink); }
.ck .btn:hover { border-color:var(--ink); }
.ck .btn.pri { background:var(--ink); border-color:var(--ink); color:var(--surface); }
.ck .btn.pri:disabled { background:var(--rule); border-color:var(--rule); color:var(--ink3); cursor:default; }
.ck .btn.talk { border-color:var(--focus); color:var(--focus); }
.ck .btn.quiet { border-color:transparent; color:var(--ink2); font-weight:400; text-decoration:underline; text-underline-offset:3px; }
/* 枠の無い副の操作も、下線で押せると分かるようにする（Neon 追加 23）。 */
.ck .acts .hint { margin-left:auto; font-size:var(--fs-xs); color:var(--ink3); }
.ck kbd { font:inherit; font-size:var(--fs-xs); border:1px solid var(--ink3); border-radius:4px; padding:0 4px; }

/* ── 右の列: 案件の今・話し中・顧客待ち・報告・片付いた ── */
/* 右の列は区切り線で区分を分け、囲みの箱にしない（R111）。 */
.ck .side { display:grid; align-content:start; min-width:0; border-top:1px solid var(--rule); }
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
.ck details.soft { grid-column:1 / -1; margin-bottom:8px; font-size:var(--fs-s); color:var(--ink2); }
.ck details.soft summary { cursor:pointer; }
/* 開いても画面を押し下げないよう、横に流して高さを抑える。 */
.ck details.soft ul, .ck.win .wnotes ul { margin:4px 0 2px; padding:0; list-style:none; font-size:var(--fs-xs); display:flex; flex-wrap:wrap; gap:2px 16px; max-height:6em; overflow-y:auto; }
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
/* fill の無い文字は既定で黒になり、暗では読めないので地の文字色にする。 */
.ck svg text:not([fill]) { fill:currentColor; }

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
.ck.win .tabs .n { font-size:var(--fs-s); color:var(--ink); font-weight:700; }
.ck.win .tabs .n.z { background:none; color:var(--ink3); font-weight:400; }
.ck.win .flags { padding-bottom:10px; }
.ck.win .flags .err { color:var(--hot); font-weight:600; }
.ck.win .werrs { display:grid; gap:2px; padding:6px 18px; background:var(--hot-bg); color:var(--hot); font-size:var(--fs-s); border-bottom:1px solid var(--rule); }
.ck.win .wnotes { padding:4px 16px; font-size:var(--fs-s); color:var(--ink2); border-bottom:1px solid var(--rule); background:var(--sunk); }
.ck.win .wnotes summary { cursor:pointer; }
.ck.win .wbody { display:grid; flex:1; min-height:0; background:var(--surface); }
.ck.win .wbody.split { grid-template-columns:minmax(0,1fr) minmax(420px,44%); }
/* 狭い幅では詳細の幅を決めて、一覧の幅を残す（初見 14）。 */
@media (max-width:1100px) { .ck.win .wbody.split { grid-template-columns:minmax(0,1fr) 380px; } }
.ck.win .wpane { overflow-y:auto; padding:10px 16px 60px; display:grid; align-content:start; gap:18px; min-height:0; min-width:0; }
.ck.win .wside { overflow-y:auto; border-left:1px solid var(--rule); background:var(--surface); min-height:0; min-width:0; }
.ck.win .wpane > p { margin:0; font-size:var(--fs-s); }
.ck.win .calm { padding:24px 4px; }
@media (max-width:900px) {
  .ck.win .wbody.split { grid-template-columns:minmax(0,1fr) 320px; } }
@media (max-width:640px) {
  .ck.win { height:auto; overflow:visible; }
  .ck.win .wbody.split { grid-template-columns:minmax(0,1fr); }
  .ck.win .wside { border-left:0; border-top:1px solid var(--rule); }
  .ck.win .wpane { padding-bottom:20px; } }

/* 要対応・対応済み: 仕事のまとまりと行 */
.ck.win .sgrp { display:grid; gap:4px; }
.ck.win details.sgrp > summary { cursor:pointer; list-style:none; }
.ck.win details.sgrp > summary::-webkit-details-marker { display:none; }
.ck.win details.sgrp > summary .gh::before { content:"＋"; color:var(--ink3); }
.ck.win details.sgrp[open] > summary .gh::before { content:"－"; }
.ck.win details.sgrp[open] > summary { margin-bottom:4px; }
.ck.win .gh { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:center; font-size:var(--fs-s); padding:2px 2px 0; }
.ck.win .gh .prog { margin-left:auto; }
.ck.win .gh b { font-size:var(--fs-m); }
.ck.win .gh .mut { font-size:var(--fs-xs); }
.ck.win .subh { font-size:var(--fs-xs); color:var(--ink3); font-weight:600; }
/*
 * 一覧は行を細い線で区切ったリスト（枠・影・角丸の箱にしない。R111）。見出しの下に濃い線、行の間に薄い線。
 * 選んでいる行は、薄い地の色と左の細い線で示す（枠で囲まない）。
 */
.ck.win .rows { display:grid; border-top:1px solid var(--rule); border-bottom:1px solid var(--rule2); }
.ck.win .cardrow { display:grid; grid-template-columns:64px minmax(0,1fr) auto; gap:12px; align-items:center; border:0; border-radius:0; padding:9px 10px; background:none; text-align:left; width:100%; }
.ck.win .cardrow + .cardrow { border-top:1px solid var(--rule2); }
.ck.win .cardrow:hover { background:var(--sunk); }
.ck.win .cardrow[aria-current="true"] { background:var(--sunk); box-shadow:inset 3px 0 0 var(--focus); }
.ck.win .cardrow.cl .ti, .ck.win .cardrow.cl .kd { color:var(--ink2); font-weight:400; }
.ck.win .cardrow.k-stuck:not(.cl) .kd { color:var(--hot); }
.ck.win .kd { display:inline-flex; align-items:center; gap:5px; font-size:var(--fs-xs); font-weight:700; color:var(--kc); white-space:nowrap; }
.ck.win .cardrow .kd { display:grid; grid-template-columns:auto 1fr; }
.ck.win .cardrow .kd small { grid-column:1 / -1; font-weight:400; color:var(--ink3); }
.ck.win .cardrow .tt { min-width:0; }
.ck.win .cardrow .tl { display:flex; align-items:center; gap:6px; min-width:0; }
.ck.win .cardrow .tl .ti { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.ck.win .cardrow .tl .tag { flex:none; }
.ck.win .cardrow .crumb { display:block; font-size:var(--fs-xs); color:var(--ink3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck.win .cardrow .du { font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; text-align:right; display:grid; justify-items:end; }
.ck.win .cardrow .du.cl { max-width:240px; }
.ck.win .cardrow .du .how { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck.win .dover { color:var(--hot); font-weight:600; }
.ck.win .dnext.soon { color:var(--ink); font-weight:600; }
/* 窓の協議は副の操作なので、主のボタンの青と分ける。 */
.ck.win .btn.talk { border-color:var(--ink3); color:var(--ink); }
/* 札は語だけ（丸枠・地の色の印を並べない。初見 4・15）。協議中は強調の色、確認なしは危険の色。 */
.ck.win .tag { display:inline-block; font-size:var(--fs-xs); font-weight:400; color:var(--ink3); white-space:nowrap; }
.ck.win .tag.wait { color:var(--ink2); }
.ck.win .tag.talk { color:var(--focus); font-weight:600; }
.ck.win .tag.miss { color:var(--hot); }
.ck.win .gaps { border:1px solid var(--hot); border-radius:8px; background:var(--surface); padding:8px 12px; font-size:var(--fs-s); display:grid; gap:2px; }
.ck.win .gaps b { color:var(--hot); }
.ck.win .gaps ul { margin:4px 0 0; padding-left:1.2em; }

/* 詳細（要対応・対応済みの右） */
.ck.win .wdet { display:grid; align-content:start; min-height:100%; }
.ck.win .dh { padding:10px 16px 8px; border-bottom:1px solid var(--rule2); display:grid; gap:4px; position:sticky; top:0; background:var(--surface); z-index:1; }
.ck.win .dh .crumbs { font-size:var(--fs-xs); color:var(--ink3); display:flex; gap:6px; flex-wrap:wrap; }
.ck.win .dh .crumbs i { font-style:normal; }
.ck.win .dh .kl { display:flex; gap:10px; align-items:center; font-size:var(--fs-xs); flex-wrap:wrap; }
.ck.win .dh h2 { margin:0; font-size:var(--fs-l); line-height:1.5; }
.ck.win .note { margin:8px 16px 0; padding:8px 10px; border-radius:6px; background:var(--sunk); font-size:var(--fs-s); }
.ck.win .note.wait { background:var(--amber-bg); } .ck.win .note.wait b { color:var(--amber); }
.ck.win .note.ok { background:var(--ok-bg); } .ck.win .note.ok b { color:var(--ok); }
/* 詳細の塊は囲まず、塊の間を線で区切る（R111。囲みと引用の線が二重にならない。初見 13）。 */
.ck.win .first { margin:12px 16px 0; padding:0; border:0; display:grid; gap:10px; font-size:var(--fs-s); }
.ck.win .first + .first, .ck.win .wdet > .first + .sent, .ck.win .wdet > .sent + .first { border-top:1px solid var(--rule2); padding-top:12px; }
/* 番号の行は、下に貼り付く操作の帯に隠れないよう下にも余白を取る。 */
.ck.win .rid { margin:14px 16px 20px; font-size:var(--fs-xs); color:var(--ink3); }
.ck.win .rid code { margin-left:.5em; font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace; }
.ck.win .links.main .lk { border-color:var(--ink3); padding:5px 14px; font-size:var(--fs-s); font-weight:600; border-radius:7px; }
.ck.win .links.main .lk i { display:none; }
.ck.win .first ol.rich, .ck.win .first ul.rich { margin:0; padding-left:1.4em; }
.ck.win details.more-d { margin:6px 16px 0; }
.ck.win details.more-d summary { cursor:pointer; font-size:var(--fs-s); color:var(--focus); padding:6px 0; }
.ck.win details.more-d .slots { display:grid; gap:10px; padding:4px 0 8px; font-size:var(--fs-s); }
.ck.win .wdet > .other { margin:8px 16px 0; }
.ck.win .dbtn { margin-top:auto; position:sticky; bottom:0; background:var(--surface); }
.ck.win .dbtn .acts { position:static; margin:0; border-radius:0; padding:10px 16px; }
.ck.win .dh .crumbs .nxl { margin-left:auto; border:0; background:none; padding:0 2px; color:var(--focus); font-size:var(--fs-xs); white-space:nowrap; }

/* 全体: 形ごとの置き場所と仕事の箱 */
.ck.win .f-delegate { --fc:var(--f-delegate); } .ck.win .f-cowork { --fc:var(--f-cowork); } .ck.win .f-watch { --fc:var(--f-watch); }
/* 仕事の形は見出しの語だけで分ける（色の四角を付けない。初見 11）。 */
.ck.win .fm { display:inline-flex; align-items:center; font-size:var(--fs-s); font-weight:700; color:var(--ink); white-space:nowrap; }
.ck.win .fsec { display:grid; gap:8px; }
.ck.win .fsec > h3 { margin:4px 0 0; font-size:var(--fs-m); display:flex; gap:10px; align-items:baseline; }
.ck.win .fsec > h3 .mut { font-weight:400; font-size:var(--fs-xs); }
.ck.win .fsec > p { margin:0; font-size:var(--fs-s); }
/* 仕事は線で区切った一覧の 1 行（箱にしない。R111）。 */
.ck.win .fsec > .st:first-of-type { border-top:1px solid var(--rule); }
.ck.win .st { border-bottom:1px solid var(--rule2); }
.ck.win .st > .sh { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 16px; padding:10px 4px; }
.ck.win .st .t { font-weight:700; font-size:var(--fs-l); display:flex; gap:10px; align-items:baseline; flex-wrap:nowrap; min-width:0; border:0; background:none; padding:0; text-align:left; }
.ck.win .st .t::before { content:"＋"; color:var(--ink3); font-weight:400; }
.ck.win .st .t[aria-expanded="true"]::before { content:"－"; }
/* 次と担当の行を、開閉の印の幅だけ下げて仕事の名前にそろえる。 */
.ck.win .st > .sh > .nxt, .ck.win .st > .sh > .meta { padding-left:26px; }
.ck.win .st .t .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.ck.win .st .right { display:flex; align-items:center; gap:10px; }
/* 次にやることを 2 行まで、工程より濃く読ませる（初見 5）。 */
.ck.win .st .nxt { grid-column:1 / -1; font-size:var(--fs-s); color:var(--ink); display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
.ck.win .st .meta { grid-column:1 / -1; font-size:var(--fs-xs); color:var(--ink3); }
/* 状態は語 1 つ。色は要対応と停止だけ（初見 4・11）。 */
.ck.win .pst { flex:none; font-size:var(--fs-xs); font-weight:400; color:var(--ink3); white-space:nowrap; }
.ck.win .pst.mine { color:var(--focus); font-weight:700; }
.ck.win .pst.stopped { color:var(--hot); font-weight:700; }
/* 工程の進み（工程 n/5 と段の名前）。上下の箱で位置がそろうよう幅を決める。 */
.ck.win .pbar { display:inline-block; min-width:9.5em; font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; }
.ck.win .pbar .num { margin:0 .3em; }
.ck.win .prog { display:inline-flex; align-items:center; gap:8px; font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; }
.ck.win .pill { display:inline-flex; align-items:center; font-size:var(--fs-xs); font-weight:600; border-radius:999px; padding:1px 9px; white-space:nowrap; }
.ck.win .pill.mine { background:var(--mine); color:var(--surface); }
.ck.win .pill.stopped { background:var(--hot); color:var(--surface); }
.ck.win .pill.working { background:var(--run-bg); color:var(--focus); }
.ck.win .pill.customer { background:var(--amber-bg); color:var(--amber); }
.ck.win .pill.idle { background:var(--sunk); color:var(--ink2); }
.ck.win .pill.done { background:var(--ok-bg); color:var(--ok); }
/* 開いた中身は、開閉の印の幅だけ下げて仕事の名前より左に出さない。 */
.ck.win .st .inner { padding:0 4px 10px 26px; display:grid; gap:0; }
.ck.win .phase { font-size:var(--fs-xs); color:var(--ink3); font-weight:600; letter-spacing:.04em; padding:6px 0 0; display:flex; gap:8px; align-items:center; }
.ck.win .task { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:start; font-size:var(--fs-s); margin:0 -12px; padding-right:12px; }
.ck.win .tsel { display:grid; grid-template-columns:4.5em minmax(0,1fr); gap:8px; align-items:start; border:0; background:none; text-align:left; padding:3px 6px 3px 12px; font:inherit; color:inherit; min-width:0; }
.ck.win .task:hover { background:var(--sunk); }
.ck.win .task:has(> .tsel[aria-current="true"]) { background:var(--sunk); box-shadow:inset 3px 0 0 var(--focus); }
.ck.win .task .wk { padding-top:3px; }
.ck.win .tst { font-size:var(--fs-xs); color:var(--ink2); padding-top:2px; white-space:nowrap; }
.ck.win .tst.s-run { color:var(--ink); font-weight:600; } .ck.win .tst.s-stop { color:var(--hot); font-weight:600; }
.ck.win .task .tn { display:grid; min-width:0; }
.ck.win .cardrow .kd small, .ck.win .task .id { font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace; }
.ck.win .task .id { color:var(--ink3); font-size:var(--fs-xs); margin-right:6px; }
.ck.win .task .nx { color:var(--ink2); font-size:var(--fs-xs); display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
.ck.win .task .wk { display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
/* 状態の印は押せる見た目にしない（枠を付けない）。枠を持つのは押せるもの（.act と仕事のカードへ移る .kc）だけ。 */
.ck.win .chip { display:inline-flex; gap:4px; align-items:center; font-size:var(--fs-xs); border:0; padding:0; background:none; color:var(--ink2); white-space:nowrap; }
.ck.win .chip.live { color:var(--ink); font-weight:600; }
.ck.win .chip.bad { color:var(--hot); font-weight:600; }
.ck.win .chip.kc { border:1px solid var(--ink3); border-radius:5px; padding:0 6px; color:var(--ink); background:var(--surface); font-weight:600; }
.ck.win .act { border:1px solid var(--ink3); background:var(--surface); border-radius:5px; padding:0 8px; font-size:var(--fs-xs); color:var(--ink); white-space:nowrap; line-height:1.9; }
.ck.win .act:hover { border-color:var(--ink); }
.ck.win .act.talk { border-color:var(--focus); color:var(--focus); }
/* タスクの行の「話す」は、行に触れたときだけ出す（全部の行に同じボタンが並ぶと、読む行の頭が埋もれる）。 */
.ck.win .task .act.talk { visibility:hidden; }
.ck.win .task:hover .act.talk, .ck.win .task:focus-within .act.talk { visibility:visible; }
.ck.win .donebox { font-size:var(--fs-xs); color:var(--ink3); padding:4px 0 0; }
.ck.win .wmore { border:0; background:none; color:var(--focus); font-size:var(--fs-s); padding:2px 0; text-align:left; justify-self:start; }
.ck.win .watch { display:grid; gap:6px; }
.ck.win .watch ul { margin:0; padding-left:1.2em; font-size:var(--fs-s); }
.ck.win .watch p { margin:0; font-size:var(--fs-s); }
.ck.win .watch .strips { margin:0; background:none; }
/* 届いた連絡の題は、見張るの見出しより弱くする（見出し → 小見出し → 項目の順）。 */
.ck.win .watch .strip .title { font-size:var(--fs-m); font-weight:400; }

/* 全体の右: タスクの詳細 */
.ck.win .wk2 { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; }
.ck.win .lc { display:grid; grid-template-columns:3.4em minmax(0,1fr) auto; gap:8px; align-items:center; width:100%; text-align:left; border:0; background:none; padding:5px 6px; margin:0 -6px; border-radius:5px; font:inherit; color:inherit; }
.ck.win button.lc:hover { background:var(--sunk); }
.ck.win .lc .ti { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck.win .lc .mut { font-size:var(--fs-xs); white-space:nowrap; max-width:16em; overflow:hidden; text-overflow:ellipsis; }
/* 済んだカードは弱く、要対応・修正待ちだけを目立たせる。 */
.ck.win .lc.cl, .ck.win .lc.cl .kd { color:var(--ink3); font-weight:400; }
.ck.win .lc .kd.hotc { color:var(--hot); }
.ck.win .rqd { display:grid; gap:6px; }
.ck.win .rqd .code, .ck.win .tid { margin-right:6px; }
.ck.win .rqd .rst { white-space:nowrap; margin-left:8px; color:var(--ink3); font-size:var(--fs-xs); }
.ck.win .lc .now { font-size:var(--fs-xs); font-weight:700; color:var(--ink); white-space:nowrap; }
/* タスクの事実はラベルを左、値を右にそろえる。 */
.ck.win .facts .fld { grid-template-columns:6.5em minmax(0,1fr); gap:10px; align-items:baseline; }
.ck.win .facts .fld > .lb { font-size:var(--fs-xs); }
.ck.win .rqd + .rqd { border-top:1px solid var(--rule2); padding-top:8px; margin-top:4px; }
.ck.win .dw { margin:0; padding:0; list-style:none; display:grid; gap:2px; }
.ck.win .dw li { display:grid; grid-template-columns:1.6em minmax(0,1fr); align-items:baseline; color:var(--ink); }
.ck.win .dw li.ok { color:var(--ink2); }
/* 済の条件のチェックの形。済は塗り、未は枠だけ。 */
.ck.win .dw .cb { width:12px; height:12px; border:1.5px solid var(--ink3); border-radius:2px; display:inline-block; position:relative; top:1px; }
.ck.win .dw li.ok .cb { background:var(--ink2); border-color:var(--ink2); }
.ck.win .dw li.ok .cb::after { content:""; position:absolute; left:3px; top:0; width:3px; height:7px; border:solid var(--surface); border-width:0 2px 2px 0; transform:rotate(45deg); }
.ck.win .purp { margin:8px 16px 0; font-size:var(--fs-s); color:var(--ink2); line-height:1.6; }
.ck.win .recm { display:block; min-width:0; font-size:var(--fs-xs); color:var(--ink2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck.win details.cont summary { cursor:pointer; font-size:var(--fs-xs); color:var(--focus); padding:2px 0; }
.ck.win .ntr { font-size:var(--fs-s); color:var(--ink2); }
.ck.win .ntr summary { cursor:pointer; color:var(--focus); }
.ck.win .ntr ul { margin:4px 0 0; padding:0; list-style:none; display:grid; gap:2px; font-size:var(--fs-s); }
.ck.win .ntr .code { margin-right:6px; }
.ck.win .ntr .rst { white-space:nowrap; margin-left:8px; color:var(--ink3); font-size:var(--fs-xs); }
.ck.win .wk2 + .wk2 { margin-top:4px; }
/* 出した指示（新しい順） */
.ck.win .wdet > .sent { margin:10px 16px 0; }
.ck.win .sent ol { margin:0; padding:0; list-style:none; display:grid; }
.ck.win .sent li { display:grid; gap:3px; padding:5px 0; font-size:var(--fs-s); }
.ck.win .sent li + li { border-top:1px solid var(--rule2); }
.ck.win .sent button.code { border:0; background:none; padding:0; font:inherit; color:inherit; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
.ck.win .sent .sl { display:flex; flex-wrap:wrap; gap:4px 10px; align-items:center; }
.ck.win .sent .tm { font-size:var(--fs-xs); color:var(--ink3); font-variant-numeric:tabular-nums; min-width:8.5em; }
/* 1366 以下では操作の帯のキーの説明を外し、「次へ」まで 1 行に収める。 */
@media (max-width:1366px) { .ck.win .dbtn .acts .hint { display:none; } }
`
