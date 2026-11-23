// 操縦席の見た目。管制の運航票（flight strip）のボードに見立て、カードを期限の軸にぶら下げる。
// 目立たせるのは左の期限の軸だけにし、ほかは静かに保つ。外部のフォントは読み込まない（パネルは Orca のサンドボックス）。
export const CSS = `
.ck { color-scheme: light;
  --bg:#e9edf0; --surface:#ffffff; --sunk:#f3f5f7; --ink:#15212c; --ink2:#4b5966; --ink3:#5c6671; --rule:#d3dae0; --rule2:#e4e9ed;
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
.ck .flags { margin-left:auto; display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; font-size:var(--fs-s); color:var(--ink2); }
.ck .flag { display:inline-flex; gap:6px; align-items:center; border:0; background:none; padding:2px 0; color:inherit; }
.ck .flag.warn { color:var(--ink); font-weight:600; text-decoration:underline; text-underline-offset:3px; }
.ck .flag.err { color:var(--hot); font-weight:600; }
.ck .seg { display:inline-flex; border:1px solid var(--ink3); border-radius:6px; overflow:hidden; }
.ck .seg button { border:0; background:none; padding:0 8px; font-size:var(--fs-xs); color:var(--ink2); }
.ck .seg button[aria-pressed="true"] { background:var(--ink); color:var(--surface); }

/* ── 3 つの列 ── */
.ck .board { display:grid; grid-template-columns:248px minmax(0,1fr) 360px; gap:0 20px; padding:16px 20px 80px; max-width:1560px; margin:0 auto; align-items:start; }
.ck .board.panel { grid-template-columns:minmax(0,1fr); padding:10px 12px 72px; }
.ck .paneswitch { display:none; gap:4px; flex:1 1 auto; min-width:0; }
.ck .paneswitch button { flex:1 1 auto; white-space:nowrap; border:1px solid var(--ink3); background:none; border-radius:7px; padding:4px 8px; font-size:var(--fs-s); font-weight:600; color:var(--ink2); }
.ck .paneswitch button[aria-selected="true"] { background:var(--ink); color:var(--surface); border-color:var(--ink); }
.ck .paneswitch b { color:inherit; }
.ck.pnl details.more summary { color:var(--focus); font-weight:400; }
@container (max-width:1180px) { .ck .board { grid-template-columns:200px minmax(0,1fr); } .ck .board .side { grid-column:2; } }
@container (max-width:760px) { .ck .board { grid-template-columns:minmax(0,1fr); padding:10px 12px 72px; } .ck .board .side { grid-column:auto; }
  /* 狭い幅では、合計を兼ねる「私の番 n」の切り替えと合図を 1 段に並べる（操作の段を重ねない。初見 2 巡目 1）。 */
  .ck .top { padding:8px 12px; gap:6px 10px; } .ck .tally { display:none; }
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
  .ck .case { flex:none; grid-template-columns:auto auto; padding:4px 10px; border:1px solid var(--ink3); border-radius:999px; }
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
.ck .now-line i { height:2px; background:var(--focus); border-radius:1px; }
/* 票は区切り線で並べ、囲みの箱にしない（R111）。 */
.ck .strips { display:grid; margin:8px 0; min-width:0; border-block:1px solid var(--rule); }
/* 票は地の上に線で区切って並べ、開いた票だけ面の色で浮かせる（白い箱を並べない。追加 22）。 */
.ck .strip[aria-expanded="true"] { background:var(--surface); }
@container (max-width:520px) { .ck .lane { grid-template-columns:minmax(0,1fr); } .ck .when { text-align:left; padding:10px 0 0; } .ck .when::after { display:none; }
  .ck .when small { display:inline; margin-left:6px; } .ck .now-line { grid-template-columns:auto minmax(0,1fr); }
  /* 狭い幅で案件名と仕事の名前が並ぶと、どちらも数文字に削られるので、案件名があるときは仕事の名前を出さない。 */
  .ck .strip .meta .ws ~ .jobname { display:none; } .ck .strip .ws { max-width:none; }
  .ck .flag.live, .ck .acts .hint { display:none; } }

.ck .strip { position:relative; min-width:0; scroll-margin:84px 0 16px; }
.ck .strip + .strip { border-top:1px solid var(--rule2); }
.ck .strip[aria-expanded="true"] { box-shadow:inset 3px 0 0 var(--focus); }
.ck .strip.hot { --hotline:var(--hot); }
.ck .strip .head { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:0 12px; width:100%; text-align:left; border:0; background:none; padding:8px 16px; }
.ck .sp > .pt + .pt { margin-left:.9em; }
.ck .pl { font-weight:600; color:var(--ink2); margin-right:.6em; }
/* 種類・案件・仕事は 1 行に固定し、長い仕事の名前は末尾を省く（題の書き出しの位置をそろえる）。 */
.ck .strip .meta { display:flex; flex-wrap:nowrap; align-items:center; gap:4px 8px; font-size:var(--fs-xs); color:var(--ink3); min-width:0; white-space:nowrap; overflow:hidden; }
.ck .strip .meta > * { flex-shrink:0; }
/* 行の ID は質問で打つために写せるようにする（行はボタンなので、字だけ選べるように戻す）。 */
.ck .cid { color:var(--ink3); font-weight:400; user-select:text; -webkit-user-select:text; cursor:text; }
.ck .cid .cv { margin-left:.35em; }
.ck .strip .meta > :last-child:not(.kind) { flex-shrink:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.ck .strip .kind { display:inline-flex; align-items:center; gap:4px; color:var(--kc); font-weight:700; }
.ck .strip .ws { color:var(--ink2); font-weight:600; max-width:45%; overflow:hidden; text-overflow:ellipsis; }
.ck .strip .title { grid-column:1 / -1; font-size:var(--fs-l); font-weight:600; line-height:1.45; color:var(--ink); }
.ck .strip .due { grid-row:1; grid-column:2; align-self:start; text-align:right; font-size:var(--fs-s); font-weight:400; color:var(--ink2); white-space:nowrap; }
.ck .due.dover { color:var(--hot); font-weight:600; }
.ck .due.dnext.soon { color:var(--ink); font-weight:600; }
.ck .strip .peek { grid-column:1 / -1; font-size:var(--fs-s); color:var(--ink2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ck .strip[aria-expanded="true"] .peek { display:none; }
.ck .k-inbox { --kc:var(--k-inbox); } .ck .k-send { --kc:var(--k-send); } .ck .k-decide { --kc:var(--k-decide); } .ck .k-review { --kc:var(--k-review); }
.ck .k-permit { --kc:var(--k-permit); } .ck .k-stuck { --kc:var(--k-stuck); } .ck .k-talk { --kc:var(--k-talk); } .ck .k-report { --kc:var(--k-report); } .ck .k-consult { --kc:var(--k-consult); }

/* 開いた票の中身 */
.ck .body { padding:0 16px 16px 16px; display:grid; gap:12px; min-width:0; }
.ck .fld { display:grid; gap:4px; min-width:0; }
.ck .fld > .lb { font-size:var(--fs-xs); font-weight:600; color:var(--ink3); }
.ck .fld > div, .ck .fld > p { margin:0; overflow-wrap:anywhere; }
.ck .ctx { display:grid; grid-template-columns:11em minmax(0,1fr); gap:8px 16px; margin:0; font-size:var(--fs-s); }
.ck .ctx dt { color:var(--ink3); font-weight:600; font-size:var(--fs-xs); }
.ck .ctx dd { margin:0; overflow-wrap:anywhere; }
@container (max-width:520px) { .ck .ctx { grid-template-columns:minmax(0,1fr); gap:0; } .ck .ctx dd { margin-bottom:8px; } }
.ck .rich ul { margin:4px 0; padding-left:1.2em; }
.ck .rich p { margin:0 0 4px; }
.ck .msg { border:1px solid var(--rule); border-radius:10px; background:var(--sunk); padding:8px 12px; white-space:pre-wrap; overflow-wrap:anywhere; font-size:var(--fs-s); max-height:22em; overflow:auto; }
.ck .msg-to { font-size:var(--fs-xs); color:var(--ink2); }
.ck .cmd { display:flex; gap:8px; align-items:flex-start; }
.ck .cmd pre { margin:0; flex:1; min-width:0; }
.ck .msg-to b { color:var(--ink); }
.ck .quote { border-left:3px solid var(--rule); padding:4px 0 4px 8px; color:var(--ink2); font-size:var(--fs-s); white-space:pre-wrap; overflow-wrap:anywhere; }
.ck .opts { display:grid; gap:8px; margin:0; padding:0; border:0; min-width:0; }
.ck .opt { display:grid; grid-template-columns:26px minmax(0,1fr); gap:0 8px; align-items:start; text-align:left; width:100%;
  border:1px solid var(--ink3); border-radius:8px; background:var(--surface); padding:8px 12px 8px 8px; }
.ck .opt:hover { border-color:var(--ink); }
.ck .opt[aria-checked="true"] { border-color:var(--kc); box-shadow:inset 0 0 0 1px var(--kc); }
.ck .opt .key { font-size:var(--fs-xs); font-weight:700; color:var(--ink3); border:1px solid var(--ink3); border-radius:5px; height:22px; display:grid; place-items:center; }
.ck .opt[aria-checked="true"] .key { background:var(--kc); border-color:var(--kc); color:var(--surface); }
.ck .opt .lbl { font-weight:600; }
.ck .opt .rec { font-size:var(--fs-xs); font-weight:600; color:var(--ok); margin-left:8px; }
.ck .opt .ex { display:block; font-size:var(--fs-s); color:var(--ink2); }
.ck details.more { border-top:1px solid var(--rule2); padding-top:8px; }
.ck details.more summary { cursor:pointer; font-size:var(--fs-s); color:var(--ink2); font-weight:600; }
.ck details.more > div { display:grid; gap:8px; margin-top:8px; }
.ck .fig svg { max-width:100%; height:auto; }
.ck table.cmp { border-collapse:collapse; font-size:var(--fs-s); }
.ck table.cmp th, .ck table.cmp td { border:1px solid var(--rule); padding:4px 8px; text-align:left; vertical-align:top; }
.ck .tblwrap { overflow-x:auto; }
.ck .links { display:flex; flex-wrap:wrap; gap:8px; }
.ck .msg + .links { margin-top:8px; }
.ck .lk { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--ink3); background:var(--surface); border-radius:6px; padding:0 8px; font-size:var(--fs-s); color:var(--ink); max-width:100%; }
.ck .lk i { font-style:normal; font-size:var(--fs-xs); font-weight:700; color:var(--ink3); }
.ck .lk span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck a.inl, .ck button.inl { border:0; background:none; padding:0; color:var(--focus); text-decoration:underline; text-underline-offset:2px; }
.ck .owner { display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; font-size:var(--fs-xs); color:var(--ink3); }
.ck .owner b { color:var(--ink2); font-weight:600; }
.ck .done-list { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
.ck .done-list li { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 8px; align-items:start; border-bottom:1px solid var(--rule2); padding-bottom:8px; }
.ck .done-list small { grid-column:1; color:var(--ink3); font-size:var(--fs-xs); }
.ck .other textarea { width:100%; field-sizing:content; min-height:calc(6lh + 18px); max-height:50vh; resize:vertical; font:inherit; font-size:var(--fs-s); line-height:1.6; border:1px solid var(--ink3); border-radius:8px; padding:8px 8px; background:var(--surface); color:var(--ink); }
.ck .other .cnt { font-size:var(--fs-xs); color:var(--ink3); }

/* 返答の列。低い窓でも見えるよう、開いた票の下に留める。 */
.ck .acts { position:sticky; bottom:0; display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:8px 16px; margin:0 -16px -12px -12px;
  background:var(--surface); border-top:1px solid var(--rule2); border-radius:0 0 8px 8px; }
.ck .btn { white-space:nowrap; border:1px solid var(--ink3); background:var(--surface); border-radius:7px; padding:4px 12px; font-size:var(--fs-s); font-weight:600; color:var(--ink); }
.ck .btn:hover { border-color:var(--ink); }
.ck .btn.pri { background:var(--ink); border-color:var(--ink); color:var(--surface); }
.ck .btn.pri:disabled { background:var(--rule); border-color:var(--rule); color:var(--ink2); cursor:default; }
.ck .btn:disabled:not(.pri) { color:var(--ink3); border-color:var(--rule); cursor:default; }
.ck .btn.talk { border-color:var(--focus); color:var(--focus); }
.ck .btn.quiet { border-color:transparent; background:none; padding-inline:4px; color:var(--ink2); font-weight:400; text-decoration:underline; text-underline-offset:3px; }
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
.ck .calm { display:grid; gap:8px; padding:40px 8px; text-align:left; }
.ck .calm b { font-size:var(--fs-xl); }
.ck .calm p { margin:0; color:var(--ink2); }
.ck .calm.warn b { color:var(--k-permit); }
.ck .notes { grid-column:1 / -1; display:grid; gap:4px; margin-bottom:12px; }
.ck .notes div { background:var(--surface); border:1px solid var(--rule); border-radius:6px; padding:8px 8px; font-size:var(--fs-s); color:var(--ink2); }
.ck .notes.warn { background:var(--surface); border:1px solid var(--rule); border-left:3px solid var(--k-permit); border-radius:6px; padding:8px 12px; gap:4px; font-size:var(--fs-s); }
.ck .notes.warn > b { color:var(--k-permit); }
.ck .notes.warn div { background:none; border:0; padding:0; }
/* 切り替えのタブと同じ段に並ぶので、枠を付けずタブと見分ける（押せることは下線で示す。初見 2 巡目の追加）。 */
.ck .flag.repeat { border:0; padding:1px 0; font-size:var(--fs-xs); color:var(--ink2); text-decoration:underline; text-underline-offset:3px; cursor:pointer; }
.ck .errs { grid-column:1 / -1; display:grid; gap:4px; margin-bottom:12px; }
.ck .chores { grid-column:1 / -1; margin-bottom:8px; font-size:var(--fs-s); color:var(--ink2); }
.ck .chores b, .ck.win .wnotes b { font-weight:600; margin-right:8px; }
.ck .chores .by, .ck.win .wnotes .by { margin-left:12px; }
.ck .errs div { background:var(--hot-bg); color:var(--hot); border-radius:6px; padding:6px 10px; font-size:var(--fs-s); font-weight:600; }
.ck .toasts { position:fixed; left:16px; bottom:calc(10px + env(safe-area-inset-bottom, 0px)); z-index:10; width:max-content; max-width:min(440px, calc(100vw - 32px)); }
.ck .toast {
  display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; background:var(--ink); color:var(--surface); border-radius:8px; padding:8px 8px; font-size:var(--fs-xs); box-shadow:0 6px 20px rgba(0,0,0,.22); }
.ck .toast .tm { display:flex; flex:1 1 0; min-width:0; overflow:hidden; white-space:nowrap; }
.ck .toast .tm > span { flex:0 1 auto; min-width:2em; overflow:hidden; text-overflow:ellipsis; }
/* 動詞と届け先は縮めず、題を先に縮める。 */
.ck .toast .tm > .tt { flex-shrink:1000; min-width:4em; }
.ck .toast .tm > .tv { flex:none; }
.ck .toast .tx { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.ck .toast .more { order:3; flex-basis:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.8; }
.ck .toast .tm > span:last-child { flex:none; min-width:0; }
.ck .toast button { flex:none; border:1px solid currentColor; background:none; color:inherit; border-radius:6px; padding:0 8px; font-weight:600; font-size:var(--fs-xs); }
.ck.win .toasts { --tl:16px; --td:max(420px, 44vw); left:var(--tl); bottom:max(16px, env(safe-area-inset-bottom, 0px)); max-width:min(560px, calc(100vw - var(--tl) - var(--td) - 16px)); }
.ck.win.side-open .toasts { --tl:236px; }
@media (max-width:1100px) { .ck.win .toasts { --td:380px; } }
/* 狭い窓とパネルでは画面の下に出し、出ているあいだは下に貼り付く操作の帯の下に 2 行の通知が収まる余白を足して、そこに置く（入力欄と帯のボタンに掛けない）。 */
.ck:not(.win):has(.toasts) .strip .acts { padding-bottom:calc(76px + env(safe-area-inset-bottom, 0px)); }
@media (max-width:900px) {
  .ck.win .toasts, .ck.win.side-open .toasts { --tl:16px; --td:0px; bottom:calc(10px + env(safe-area-inset-bottom, 0px)); }
  .ck.win:has(.toasts) .dbtn { padding-bottom:calc(72px + env(safe-area-inset-bottom, 0px)); } }
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
 * 字の段の役割（t123）: 16 は題（仕事・詳細・案件の名前）、14 は本文と区分の見出し、12 はラベル・補助・工程。行の高さは本文 1.7（DADS の本文 170%）、
 * 題 1.5。余白は 4 の倍数（4・8・12・16・24）で、関係の近いものほど狭くする（近接）。
 * 押せる物と入力欄の枠は --ink3 にする（地との比 3:1 以上。追加 51）。--rule・--rule2 は区切りの線・飾り・無効のボタンの地だけに使う。
 */
.ck.win, .ck.pnl {
  --k-inbox:var(--ink2); --k-send:var(--ink2); --k-decide:var(--ink2); --k-review:var(--ink2); --k-permit:var(--ink2); --k-stuck:var(--ink2); --k-talk:var(--ink2); --k-report:var(--ink2); --k-consult:var(--ink2);
  --ok:var(--ink2); --ok-bg:var(--sunk); --amber:var(--ink2); --amber-bg:var(--sunk); --run:var(--focus); --run-bg:var(--sunk); --mine:var(--ink);
  --fs-xs:12px; --fs-s:14px; --fs-m:14px; --fs-l:16px; --fs-xl:20px; }
/*
 * パネルも窓と同じ色の役割にし、地は面の色 1 枚にする。開いた票は箱で浮かせず、選んでいる行の強調（薄い地と左の線）にとどめる（R111・初見 2 巡目 1）。
 * 停止の語だけを危険の色にする（窓の一覧の行と同じ）。
 */
.ck.pnl { background:var(--surface); }
.ck.pnl .top { background:var(--surface); }
.ck.pnl .strip[aria-expanded="true"] { background:var(--sunk); }
.ck.pnl .strip .acts { background:var(--sunk); border-radius:0; }
.ck.pnl .strip.k-stuck .kind { color:var(--hot); }
.ck.win {
  height:100vh; min-height:0; display:flex; flex-direction:column; overflow:hidden; line-height:1.7; }
.ck.win .pad { padding:16px; }
.ck.win .hotc { color:var(--hot); }
.ck.win .wtop { display:flex; flex-wrap:wrap; align-items:center; gap:8px 24px; padding:12px 16px 0; border-bottom:1px solid var(--rule); background:var(--bg); }
.ck.win .pj { font-weight:700; font-size:var(--fs-l); line-height:1.5; padding-bottom:12px; }
.ck.win .tabs { display:flex; gap:4px; align-self:end; }
.ck.win .tabs button { border:0; background:none; padding:8px 16px; font-size:var(--fs-m); color:var(--ink2); border-bottom:3px solid transparent; display:flex; gap:8px; align-items:center; }
.ck.win .tabs button[aria-selected="true"] { color:var(--ink); font-weight:700; border-bottom-color:var(--ink); }
.ck.win .tabs .n { font-size:var(--fs-s); color:var(--ink); font-weight:700; }
.ck.win .tabs .n.z { background:none; color:var(--ink3); font-weight:400; }
.ck.win .flags { padding-bottom:12px; }
.ck.win .flags .err { color:var(--hot); font-weight:600; }
.ck.win .werrs { display:grid; gap:4px; padding:8px 16px; background:var(--hot-bg); color:var(--hot); font-size:var(--fs-s); border-bottom:1px solid var(--rule); }
.ck.win .wsince { padding:4px 16px; font-size:var(--fs-s); color:var(--ink2); border-bottom:1px solid var(--rule); }
.ck.win .wsince b { font-weight:600; color:var(--ink); margin-right:8px; }
.ck.win .wnotes { padding:4px 16px; font-size:var(--fs-s); color:var(--ink2); border-bottom:1px solid var(--rule); background:var(--sunk); }
.ck.win .wmain { display:flex; flex:1; min-height:0; position:relative; }
.ck.win .wcol { display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; }
.ck.win .wcases { flex:none; width:220px; overflow-y:auto; border-right:1px solid var(--rule); background:var(--bg); padding:8px 0 24px; display:grid; align-content:start; }
.ck.win .wcase { border:0; border-radius:0; background:none; text-align:left; padding:8px 16px; display:grid; gap:0; color:var(--ink); }
.ck.win .wcase:hover { background:var(--sunk); }
/* サイドバーの地（--bg）の上では --sunk の差が小さいので、選んだ行は本文の地（--surface）にする。 */
.ck.win .wcase[aria-current="true"] { background:var(--surface); font-weight:700; box-shadow:inset 3px 0 0 var(--focus); }
.ck.win .wcase .n { font-size:var(--fs-s); color:var(--ink); font-weight:600; }
.ck.win .wcase .here { font-size:var(--fs-xs); color:var(--ink2); font-weight:400; }
/* 開閉で語も幅も変えず、開いているときは押し込んだ見た目にする（R179: 押す場所を動かさない）。 */
.ck.win .sidebtn { align-self:center; margin-bottom:12px; flex:none; border:1px solid var(--ink3); border-radius:6px; background:var(--surface); color:var(--ink); padding:4px 12px; font-size:var(--fs-s); font-weight:600; }
.ck.win .sidebtn[aria-expanded="true"] { background:var(--sunk); border-color:var(--focus); color:var(--focus); box-shadow:inset 0 0 0 1px var(--focus); }
.ck.win .orcab { display:inline-flex; gap:8px; margin-right:12px; }
.ck.win .orcab .btn:disabled { color:var(--ink3); text-decoration:none; cursor:default; }
.ck.win .wcorca, .ck.win .wscrim { display:none; }
.ck.win .wbody { display:grid; flex:1; min-height:0; background:var(--surface); }
.ck.win .wbody.split { grid-template-columns:minmax(0,1fr) minmax(420px,44%); }
/* 狭い幅では詳細の幅を決めて、一覧の幅を残す（初見 14）。 */
@media (max-width:1100px) { .ck.win .wbody.split { grid-template-columns:minmax(0,1fr) 380px; } }
.ck.win .wbody.split:has(> .wpane[aria-label="やりとり"]) { grid-template-columns:minmax(320px,2fr) minmax(0,3fr); }
.ck.win .wpane { container:wpane / inline-size; overflow-y:auto; padding:12px 16px 64px; display:grid; align-content:start; gap:24px; min-height:0; min-width:0; }
.ck.win .wside { overflow-y:auto; border-left:1px solid var(--rule); background:var(--surface); min-height:0; min-width:0; }
.ck.win .wpane > p { margin:0; font-size:var(--fs-s); }
.ck.win .calm { padding:24px 4px; }
@media (max-width:900px) {
  .ck.win .wbody.split { grid-template-columns:minmax(0,1fr) 320px; } }
@media (max-width:640px) {
  .ck.win { height:auto; overflow:visible; }
  .ck.win .wcases { position:absolute; inset:0 auto 0 0; z-index:5; width:min(280px, 85vw); box-shadow:4px 0 16px rgb(0 0 0 / .18); }
  .ck.win .wscrim { display:block; position:absolute; inset:0; z-index:4; border:0; padding:0; background:rgb(0 0 0 / .45); }
  .ck.win .wtop .orcab { display:none; }
  .ck.win .wcorca { display:block; padding:12px 16px 0; border-top:1px solid var(--rule); margin-top:8px; }
  .ck.win .wcorca .orcab { display:grid; gap:8px; margin:0; justify-items:start; }
  .ck.win .wbody.split, .ck.win .wbody.split:has(> .wpane[aria-label="やりとり"]) { grid-template-columns:minmax(0,1fr); }
  .ck.win .wside { border-left:0; border-top:1px solid var(--rule); }
  .ck.win .wpane { padding-bottom:24px; } }

/* 要対応・対応済み: 仕事のまとまりと行 */
.ck.win .sgrp { display:grid; gap:4px; }
.ck.win details.sgrp > summary { cursor:pointer; list-style:none; }
.ck.win details.sgrp > summary::-webkit-details-marker { display:none; }
.ck.win details.sgrp > summary .gh::before { content:"＋"; color:var(--ink3); }
.ck.win details.sgrp[open] > summary .gh::before { content:"－"; }
.ck.win details.sgrp[open] > summary { margin-bottom:4px; }
/* 開閉の印の付いた見出しの下は、行の左端を見出しの文字にそろえる（全体の仕事の中身と同じ下げ幅。Neon 初見 2 巡目）。 */
.ck.win details.sgrp > .rows { margin-left:24px; }
.ck.win .gh { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:center; font-size:var(--fs-s); padding:4px 4px 0; }
.ck.win .gh .pbar { min-width:0; }
/* 仕事の名前だけを題の段にする（工程の今の段の太字 b.sc は工程の行の大きさのまま）。 */
.ck.win .gh > b { font-size:var(--fs-l); line-height:1.5; }
.ck.win .gh .mut { font-size:var(--fs-xs); }
.ck.win .subh { font-size:var(--fs-xs); color:var(--ink3); font-weight:600; }
/*
 * 一覧は行を細い線で区切ったリスト（枠・影・角丸の箱にしない。R111）。見出しの下に濃い線、行の間に薄い線。
 * 選んでいる行は、薄い地の色と左の細い線で示す（枠で囲まない）。
 */
.ck.win .rows { display:grid; border-top:1px solid var(--rule); border-bottom:1px solid var(--rule2); }
/* 先頭の語の欄は、いちばん長い語（「チャットで答える」の 8 字）が 1 行に収まる幅で固定する。行ごとに別の grid なので auto では題の書き出しがそろわない。 */
.ck.win .cardrow { display:grid; grid-template-columns:calc(var(--fs-xs) * 8) minmax(0,1fr) auto; gap:12px; align-items:center; border:0; border-radius:0; padding:8px 12px; background:none; text-align:left; width:100%; }
.ck.win .cardrow + .cardrow { border-top:1px solid var(--rule2); }
/* 一覧が狭いと語の欄の幅で題が細くなりすぎるので、語を題の上の 1 行に置く。 */
@container wpane (max-width:520px) { .ck.win .cardrow { grid-template-columns:minmax(0,1fr) auto; row-gap:4px; } .ck.win .cardrow .kd { grid-column:1 / -1; } }
.ck.win .cardrow:hover { background:var(--sunk); }
.ck.win .cardrow[aria-current="true"] { background:var(--sunk); box-shadow:inset 3px 0 0 var(--focus); }
.ck.win .cardrow.cl .ti, .ck.win .cardrow.cl .kd { color:var(--ink2); font-weight:400; }
.ck.win .cardrow.reply:not(.cl) .kd { color:var(--hot); }
.ck.win .kd { display:inline-flex; align-items:center; gap:4px; font-size:var(--fs-xs); font-weight:700; color:var(--kc); white-space:nowrap; }
.ck.win .cardrow .kd { display:grid; grid-template-columns:auto 1fr; }
.ck.win .cardrow .kd small { grid-column:1 / -1; font-weight:400; color:var(--ink3); }
.ck.win .cardrow .tt { min-width:0; }
.ck.win .cardrow .tl { display:flex; align-items:baseline; gap:8px; min-width:0; }
/* 題は行で一番知りたい文なので 2 行まで見せ、3 行目から切る（ui.md。利用者役の初見で「題名が途中で切れる」）。 */
.ck.win .cardrow .tl .ti { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2; overflow:hidden; overflow-wrap:anywhere; line-height:1.5; min-width:0; }
.ck.win .cardrow .crumb { display:block; font-size:var(--fs-xs); color:var(--ink3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck.win .cardrow .du { font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; text-align:right; display:grid; justify-items:end; }
.ck.win .cardrow .du.cl { max-width:240px; }
.ck.win .cardrow .du .how { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* 窓とパネルの協議は副の操作なので、主のボタンの青と分ける。 */
.ck.win .btn.talk, .ck.pnl .btn.talk { border-color:var(--ink3); color:var(--ink); }
/* 札は語だけ（丸枠・地の色の印を並べない。初見 4・15）。協議中は強調の色、確認なしは危険の色。 */
.ck.win .tag { display:inline-block; font-size:var(--fs-xs); font-weight:400; color:var(--ink3); white-space:nowrap; }
.ck.win .tag.wait { color:var(--ink2); }
.ck.win .tag.talk { color:var(--focus); font-weight:600; }
.ck.win .tag.miss { color:var(--hot); }
/* 状態の印は押せる語（青の文字・下線）と見分けるよう、薄い地の小さな札にする（Neon 24）。 */
.ck.win .tag.new { color:var(--focus); background:var(--run-bg); border-radius:4px; padding:0 4px; font-weight:600; }
.ck.win .tn .tag.new { margin-left:8px; }

/* 詳細（要対応・対応済みの右） */
/* 縦の flex にして、操作の帯をいつも詳細の下端に置く（短い詳細で本文のすぐ下に上がらないように。初見 2 巡目 4）。 */
.ck.win .wdet { display:flex; flex-direction:column; min-height:100%; }
.ck.win .dh { padding:12px 16px; border-bottom:1px solid var(--rule2); display:grid; gap:4px; position:sticky; top:0; background:var(--surface); z-index:1; }
.ck.win .dh .crumbs { font-size:var(--fs-xs); color:var(--ink3); display:flex; gap:8px; flex-wrap:wrap; }
.ck.win .dh .crumbs i { font-style:normal; }
.ck.win .dh .kl { display:flex; gap:8px; align-items:center; font-size:var(--fs-xs); flex-wrap:wrap; }
.ck.win .dh h2 { margin:0; font-size:var(--fs-l); line-height:1.5; }
.ck.win .note { margin:8px 16px 0; padding:8px 8px; border-radius:6px; background:var(--sunk); font-size:var(--fs-s); }
.ck.win .note.wait { background:var(--amber-bg); } .ck.win .note.wait b { color:var(--amber); }
/* 詳細の塊は囲まず、塊の間を線で区切る（R111。囲みと引用の線が二重にならない。初見 13）。 */
.ck.win .first { margin:12px 16px 0; padding:0; border:0; display:grid; gap:12px; font-size:var(--fs-s); }
.ck.win .first + .first, .ck.win .wdet > .first + .sent, .ck.win .wdet > .sent + .first { border-top:1px solid var(--rule2); padding-top:12px; }
/* 番号の行は、下に貼り付く操作の帯に隠れないよう下にも余白を取る。 */
.ck.win .rid { margin:16px 16px 24px; font-size:var(--fs-xs); color:var(--ink3); }
.ck.win .rid code { margin-left:.5em; font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace; }
.ck.win .links.main .lk { border-color:var(--ink3); padding:4px 16px; font-size:var(--fs-s); font-weight:600; border-radius:7px; }
.ck.win .links.main .lk i { display:none; }
.ck.win .first ol.rich, .ck.win .first ul.rich { margin:0; padding-left:1.4em; }
.ck.win details.more-d { margin:8px 16px 0; }
.ck.win details.more-d summary { cursor:pointer; font-size:var(--fs-s); color:var(--focus); padding:8px 0; }
.ck.win details.more-d .slots { display:grid; gap:8px; padding:4px 0 8px; font-size:var(--fs-s); }
.ck.win .wdet > .other { margin:8px 16px 0; }
.ck.win .dbtn { margin-top:auto; position:sticky; bottom:0; background:var(--surface); }
.ck.win .dbtn .acts { position:static; margin:0; border-radius:0; padding:8px 16px; }
.ck.win .dh .crumbs .nxl { margin-left:auto; border:0; background:none; padding:0 4px; color:var(--focus); font-size:var(--fs-xs); white-space:nowrap; }

/*
 * 窓から質問する（R105）。欄は線で区切り（R111）、入力欄は 4 行（R90）。答えを待つ間・判断の記録の当たり・答えは同じ字の大きさで、
 * 補助の文字（時刻・時点）を --ink3 にする。待つ間の印は回る線 1 つだけ（意味の無いアイコンを並べない。R101）。
 */
.ck.win .ask { display:grid; gap:12px; font-size:var(--fs-s); }
.ck.win .wdet > .ask { margin:14px 16px 0; padding-top:12px; border-top:1px solid var(--rule2); scroll-margin-top:120px; }
.ck.win .hits > .lb .mut { margin-left:10px; font-weight:400; font-size:var(--fs-xs); }
.ck.win .ask details.cont > summary { font-size:var(--fs-s); }
.ck.win .wpane > .ask { padding-bottom:16px; border-bottom:1px solid var(--rule); }
.ck.win .askin { display:grid; gap:8px; }
.ck.win .askin > .lb { display:flex; flex-wrap:wrap; gap:4px 10px; align-items:baseline; font-size:var(--fs-s); font-weight:700; color:var(--ink); }
.ck.win .askin > .lb .mut { font-size:var(--fs-xs); font-weight:400; }
.ck.win .askin textarea { width:100%; box-sizing:border-box; field-sizing:content; min-height:calc(2lh + 18px); max-height:60vh; resize:vertical; font:inherit; font-size:var(--fs-s); line-height:1.6; border:1px solid var(--ink3); border-radius:8px; padding:8px 12px; background:var(--surface); color:var(--ink); }
.ck.win .askin textarea:focus-visible { outline:2px solid var(--focus); outline-offset:1px; }
.ck.win .answer { display:grid; gap:12px; }
.ck.win .anslist { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.ck.win .anslist li { display:grid; gap:0; }
.ck.win .anslist .mut { font-size:var(--fs-xs); }
.ck.win .dbtn .acts .btn[data-act="answer"] { text-align:left; white-space:normal; overflow-wrap:anywhere; }
.ck.win .ansin { display:grid; gap:8px; }
.ck.win .ansin > .lb { font-size:var(--fs-xs); font-weight:600; color:var(--ink3); }
.ck.win .ansin textarea { width:100%; box-sizing:border-box; field-sizing:content; min-height:calc(2lh + 18px); max-height:40vh; resize:vertical; font:inherit; font-size:var(--fs-s); line-height:1.6; border:1px solid var(--ink3); border-radius:8px; padding:8px 12px; background:var(--surface); color:var(--ink); }
.ck.win .ansin textarea:focus-visible { outline:2px solid var(--focus); outline-offset:1px; }
.ck.win .ansin .ansgo { display:flex; gap:8px; }
.ck.win .ask .acts { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; position:static; padding:0; margin:0; background:none; border:0; }
.ck.win .ask .btn.quiet { padding-inline:0; }
.ck.win .ask > details.cont { border-top:1px solid var(--rule2); padding-top:10px; }
.ck.win .ask .tag { margin-left:8px; }
.ck.win .askst { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:center; padding:8px 12px; background:var(--sunk); }
.ck.win .askst.bad { border-left:3px solid var(--hot); } .ck.win .askst.bad b { color:var(--hot); }
.ck.win .askst .mut { font-size:var(--fs-xs); }
.ck.win .spin { width:12px; height:12px; border:2px solid var(--rule); border-top-color:var(--focus); border-radius:50%; animation:cockpit-spin 0.9s linear infinite; }
@keyframes cockpit-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion:reduce) { .ck.win .spin { animation:none; border-top-color:var(--rule); } }
.ck.win .hits { display:grid; gap:8px; padding:10px 0; border-top:1px solid var(--rule2); border-bottom:1px solid var(--rule2); }
.ck.win .hits > .lb { font-weight:700; }
.ck.win .hl { list-style:none; margin:0; padding:0; display:grid; }
.ck.win .hl li { display:grid; gap:4px; padding:8px 0; border-top:1px solid var(--rule2); }
.ck.win .hl li:first-child { border-top:0; padding-top:0; }
.ck.win .hh { display:flex; gap:8px; align-items:baseline; font-size:var(--fs-xs); }
.ck.win .hh .code { font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace; color:var(--ink); }
.ck.win .aq, .ck.win .aa { display:grid; gap:4px; }
.ck.win .aq > .mut, .ck.win .aa > .mut { font-size:var(--fs-xs); }
.ck.win .aq .verb { white-space:pre-wrap; overflow-wrap:anywhere; font-size:var(--fs-l); font-weight:600; line-height:1.5; text-wrap:pretty; word-break:auto-phrase; max-width:35em; }
/* 答えの本文は和文 40 字ほどで折る（表と囲みのコードは欄の幅まで使う）。 */
.ck.win .aa .abody p, .ck.win .aa .abody li, .ck.win .aa .abody .mdh, .ck.win .aa .abody blockquote { max-width:40em; }
.ck.win .aq.ret .ah2 { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:baseline; }
.ck.win .aq.ret .ah2 > .mut { font-size:var(--fs-xs); }
.ck.win .aq.ret ul.rich { margin:0; padding-left:1.4em; }
.ck.win .aa .rich p { margin:0 0 4px; }
.ck.win .aa .rich ul { margin:0 0 4px; padding-left:1.4em; }
/* 答え・見張る仕事の出力の Markdown（R167）。字の段は今の体系の中で選ぶ（見出しは本文と同じ大きさで太さだけ変える）。 */
.ck .md ol { margin:0 0 4px; padding-left:1.6em; }
.ck .md .mdh { margin:8px 0 4px; font-size:var(--fs-m); font-weight:700; line-height:1.5; color:var(--ink); }
.ck .md h6.mdh { font-size:var(--fs-s); font-weight:600; color:var(--ink2); }
.ck .md > .mdh:first-child { margin-top:0; }
.ck .md strong { font-weight:700; color:var(--ink); }
.ck .md blockquote { margin:4px 0; border-left:3px solid var(--rule); padding:4px 0 4px 8px; color:var(--ink2); }
.ck .md hr { border:0; border-top:1px solid var(--rule2); margin:8px 0; }
.ck .md .mdtbl { overflow-x:auto; margin:4px 0 8px; }
.ck .md table { border-collapse:collapse; font-size:var(--fs-s); min-width:100%; }
.ck .md th, .ck .md td { border:1px solid var(--rule); padding:4px 8px; text-align:left; vertical-align:top; text-wrap:pretty; word-break:auto-phrase; }
/* 狭い右の欄で列が細くなり 1〜2 字だけ次の行に落ちないよう、文節で折り返し（auto-phrase は lang=ja の文節）、列に幅の下限を置く。足りなければ表だけが横に動く（Neon 36）。 */
.ck .md td { min-width:7em; }
.ck .md th { background:var(--sunk); font-weight:600; white-space:nowrap; }
.ck .md .mdpre { margin:4px 0 8px; padding:8px 8px; background:var(--sunk); border:1px solid var(--rule2); border-radius:6px; overflow-x:auto; font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace; font-size:var(--fs-xs); line-height:1.55; white-space:pre; }
.ck.win .alist { display:grid; gap:8px; }
.ck.win .alist .ah { display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; }
.ck.win .alist h3 { margin:0; font-size:var(--fs-m); font-weight:700; }
.ck.win .afil { display:inline-flex; gap:4px; }
.ck.win .afil button { border:1px solid var(--ink3); background:none; border-radius:7px; padding:4px 12px; font-size:var(--fs-s); font-weight:600; color:var(--ink2); }
.ck.win .afil button[aria-pressed="true"] { background:var(--ink); border-color:var(--ink); color:var(--surface); }
.ck.win .arows { display:grid; border-top:1px solid var(--rule); border-bottom:1px solid var(--rule2); }
.ck.win .arow { display:grid; grid-template-columns:64px minmax(0,1fr) auto; gap:12px; align-items:start; border:0; border-radius:0; padding:8px 12px; background:none; text-align:left; width:100%; font:inherit; color:inherit; }
.ck.win .arow + .arow { border-top:1px solid var(--rule2); }
.ck.win .arow:hover { background:var(--sunk); }
.ck.win .arow[aria-current="true"] { background:var(--sunk); box-shadow:inset 3px 0 0 var(--focus); }
.ck.win .arow .at { display:grid; min-width:0; font-size:var(--fs-s); }
.ck.win .arow .ati { font-weight:600; line-height:1.5; overflow-wrap:anywhere; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
.ck.win .arow .crumb { font-size:var(--fs-xs); color:var(--ink3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck.win .arow .crumb.miss { color:var(--hot); }
.ck.win .arow .du { font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; line-height:1.75; }
.ck.win .ast { font-size:var(--fs-xs); font-weight:700; color:var(--ink2); white-space:nowrap; line-height:1.75; }
.ck.win .ast.s-answered { color:var(--focus); }
.ck.win .ast.s-done { color:var(--ink3); font-weight:400; }
.ck.win .ask > .lb { display:flex; gap:8px; align-items:baseline; font-size:var(--fs-s); font-weight:700; }
.ck.win .ask > .lb .mut { font-size:var(--fs-xs); font-weight:400; }
.ck.win .wdet > .ask .arow { padding-inline:4px; }
.ck.win .askfail { display:grid; gap:8px; }
.ck.win .alk { border:0; background:none; padding:0; font:inherit; color:var(--focus); text-decoration:underline; text-underline-offset:3px; cursor:pointer; text-align:left; }
.ck.win .athread .dh .crumbs { font-size:var(--fs-s); }
.ck.win .athread .dh .crumbs .nxl { font-size:var(--fs-s); text-decoration:underline; text-underline-offset:3px; }
.ck.win .wdet > .ask.conv { margin:12px 16px 0; padding-top:0; border-top:0; gap:16px; }
.ck.win .askpick { display:grid; gap:8px; padding:12px; background:var(--sunk); }
.ck.win .askpick > .lb { font-size:var(--fs-xs); font-weight:600; color:var(--ink3); }
.ck.win .askpick ul { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.ck.win .askpick li { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:baseline; font-size:var(--fs-s); }
.ck.win .askpick .btn { flex:none; }
.ck.win .wdet .said { display:block; overflow-wrap:anywhere; }
.ck.win .st.cur > .sh { background:var(--sunk); box-shadow:inset 3px 0 0 var(--focus); }

/* 全体: 形ごとの置き場所と仕事の箱 */
.ck.win .f-delegate { --fc:var(--f-delegate); } .ck.win .f-cowork { --fc:var(--f-cowork); } .ck.win .f-watch { --fc:var(--f-watch); }
/* 仕事の形は見出しの語だけで分ける（色の四角を付けない。初見 11）。 */
.ck.win .fm { display:inline-flex; align-items:center; font-size:var(--fs-s); font-weight:700; color:var(--ink); white-space:nowrap; }
.ck.win .fsec { display:grid; gap:8px; }
.ck.win .fsec > h3 { margin:0; font-size:var(--fs-m); display:flex; gap:8px; align-items:baseline; }
.ck.win .fsec > h3 .mut { font-weight:400; font-size:var(--fs-xs); }
.ck.win .fsec > p { margin:0; font-size:var(--fs-s); }
/* 仕事は線で区切った一覧の 1 行（箱にしない。R111）。 */
.ck.win .fsec > .st:first-of-type { border-top:1px solid var(--rule); }
.ck.win .st { border-bottom:1px solid var(--rule2); }
.ck.win .st > .sh { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 16px; padding:12px 4px; }
.ck.win .st .t { font-weight:700; font-size:var(--fs-l); display:flex; gap:8px; align-items:baseline; flex-wrap:nowrap; min-width:0; border:0; background:none; padding:0; text-align:left; line-height:1.5; }
.ck.win .st .t::before { content:"＋"; color:var(--ink3); font-weight:400; }
.ck.win .st .t[aria-expanded="true"]::before { content:"－"; }
/*
 * 概要・状況のラベルとタスクの状態は、一覧の全部の仕事で同じ幅の列（--lbw）に置き、中身とタスクの題の左端を一直線にそろえる（t123・Neon）。
 * 幅は最も長い状態の語「返事待ち（あなた）」が 1 行に収まる 112px。中身の列は 1280px の窓で約 40 字になる（和文の 1 行の目安）。
 */
.ck.win .st { --lbw:112px; }
/* 概要・状況・担当の行を、開閉の印の幅だけ下げて仕事の名前にそろえる。 */
.ck.win .st > .sh > .sx, .ck.win .st > .sh > .meta { padding-left:24px; }
.ck.win .st .sx { grid-column:1 / -1; display:grid; grid-template-columns:var(--lbw) minmax(0,1fr); gap:12px; align-items:baseline; font-size:var(--fs-s); }
.ck.win .st .sx > .lb { font-size:var(--fs-xs); font-weight:600; color:var(--ink3); }
.ck.win .st .sx > .sv { color:var(--ink); }
.ck.win .st .sx.sum > .sv { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; overflow:hidden; }
.ck.win .st .sx .said { display:block; overflow-wrap:anywhere; }
/* 題は切らずに折り返す（長い題が数文字で切れた・待ちの文に場所を取られて消えた。追加 38・42）。 */
.ck.win .st .t .nm { min-width:0; overflow-wrap:anywhere; }
/* 題・中身・タスクの題は文節で折り返し、1〜2 字だけ次の行に落とさない（Neon t123。auto-phrase は lang=ja の文節）。列より長い文節は字で折る（Codex t123）。 */
.ck.win .st .t .nm, .ck.win .st .sx > .sv, .ck.win .task .tn { word-break:auto-phrase; text-wrap:pretty; overflow-wrap:anywhere; }
.ck.win .st .right { display:flex; align-items:center; gap:8px; }
.ck.win .st .meta { grid-column:1 / -1; font-size:var(--fs-xs); color:var(--ink3); }
/* 状況の頭の状態の語。色は要対応と停止だけ（初見 4・11）。 */
.ck.win .pst { font-weight:400; }
.ck.win .pst.mine { color:var(--focus); font-weight:700; }
.ck.win .pst.stopped, .ck.win .pst.reply { color:var(--hot); font-weight:700; }
/* 工程の進み（工程 n/5 と段の名前）。上下の箱で位置がそろうよう幅を決める。 */
.ck.win .pbar { display:inline-block; text-align:right; font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; }
/* 工程の 5 語（R126）。済んだ段は薄く、今の段は太字、まだの段は済んだ段より濃い（色は足さない。R91）。 */
.ck .stg .sd { color:var(--ink3); }
.ck .stg .sn { color:var(--ink2); }
.ck .stg .sc { color:var(--ink); font-weight:700; }
.ck .stg .sep { color:var(--ink3); }
.ck .stg .stg-now { display:none; color:var(--ink2); } .ck .stg .stg-now b { color:var(--ink); font-weight:700; }
/* 一覧の行（仕事の見出しと全体の仕事の行）は、窓が狭いと今の段の語だけにする。詳細はいつも 5 語。 */
@media (max-width: 1100px) {
  .ck.win .pbar .stg-all { display:none; }
  .ck.win .pbar .stg-now { display:inline; }
}
.ck.win .prog { display:inline-flex; align-items:center; gap:8px; font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; }
.ck.win .pill { display:inline-flex; align-items:center; font-size:var(--fs-xs); font-weight:600; border-radius:999px; padding:0 8px; white-space:nowrap; }
.ck.win .pill.mine { background:var(--mine); color:var(--surface); }
.ck.win .pill.stopped { background:var(--hot); color:var(--surface); }
.ck.win .pill.working { background:var(--run-bg); color:var(--focus); }
.ck.win .pill.customer { background:var(--amber-bg); color:var(--amber); }
.ck.win .pill.idle { background:var(--sunk); color:var(--ink2); }
.ck.win .pill.done { background:var(--ok-bg); color:var(--ok); }
/* 開いた中身は、開閉の印の幅だけ下げて仕事の名前より左に出さない。 */
.ck.win .st .inner { padding:0 4px 12px 24px; display:grid; gap:0; }
.ck.win .phase { font-size:var(--fs-xs); color:var(--ink3); font-weight:600; letter-spacing:.04em; padding:12px 0 4px; display:flex; gap:8px; align-items:center; }
.ck.win .inner > .phase:first-child { padding-top:8px; }
.ck.win .task { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:start; font-size:var(--fs-s); margin:0 -12px; padding-right:12px; }
.ck.win .tsel { display:grid; grid-template-columns:var(--lbw) minmax(0,1fr); gap:12px; align-items:baseline; border:0; background:none; text-align:left; padding:4px 8px 4px 12px; font:inherit; color:inherit; min-width:0; }
.ck.win .task:hover { background:var(--sunk); }
.ck.win .task:has(> .tsel[aria-current="true"]) { background:var(--sunk); box-shadow:inset 3px 0 0 var(--focus); }
.ck.win .task .wk { padding-top:4px; }
.ck.win .tst { font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; }
.ck.win .tst.s-run { color:var(--ink); font-weight:600; } .ck.win .tst.s-stop { color:var(--hot); font-weight:600; }
/* 一覧が狭いとき（窓が狭い・案件の列を開いている）は、概要・状況とタスクの状態の列を 40px に詰めて中身の幅を残し、「返事待ち（あなた）」のタスクがある箱だけ状態の列を 112px にする（Neon・Codex t123）。 */
@container wpane (max-width:520px) { .ck.win .st { --lbw:40px; } .ck.win .inner.wide .tsel { grid-template-columns:112px minmax(0,1fr); } }
.ck.win .task .tn { display:grid; min-width:0; }
.ck.win .chk { margin-left:.6em; font-size:var(--fs-xs); color:var(--ink2); white-space:nowrap; }
.ck.win b.chk { color:var(--ink); }
.ck.win .cardrow .kd small, .ck.win .task .id { font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace; }
.ck.win .task .id { color:var(--ink3); font-size:var(--fs-xs); margin-right:8px; }
.ck.win .task .nx { color:var(--ink2); font-size:var(--fs-xs); overflow-wrap:anywhere; }
.ck.win .task .nx.gl { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
.ck.win .task .wk { display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
/* 状態の印は押せる見た目にしない（枠を付けない）。枠を持つのは押せるもの（.act と仕事のカードへ移る .kc）だけ。 */
.ck.win .chip { display:inline-flex; gap:4px; align-items:center; font-size:var(--fs-xs); border:0; padding:0; background:none; color:var(--ink2); white-space:nowrap; }
.ck.win .chip.live { color:var(--ink); font-weight:600; }
.ck.win .chip.bad { color:var(--hot); font-weight:600; }
.ck.win .chip.kc { border:1px solid var(--ink3); border-radius:5px; padding:0 8px; color:var(--ink); background:var(--surface); font-weight:600; }
.ck.win .act { border:1px solid var(--ink3); background:var(--surface); border-radius:5px; padding:0 8px; font-size:var(--fs-xs); color:var(--ink); white-space:nowrap; line-height:1.9; }
.ck.win .act:hover { border-color:var(--ink); }
.ck.win .act.talk { border-color:var(--focus); color:var(--focus); }
/* タスクの行の「話す」は、行に触れたときだけ出す（全部の行に同じボタンが並ぶと、読む行の頭が埋もれる）。 */
.ck.win .task .act.talk { visibility:hidden; }
.ck.win .task:hover .act.talk, .ck.win .task:focus-within .act.talk { visibility:visible; }
.ck.win .donebox { font-size:var(--fs-xs); color:var(--ink3); padding:8px 0 0; }
.ck.win .wmore { border:0; background:none; color:var(--focus); font-size:var(--fs-s); padding:4px 0; text-align:left; justify-self:start; }
.ck.win .watch { display:grid; gap:8px; }
/* 見張る仕事の行（R152）。押すと右に詳細。線で区切り、色は足さない。 */
.ck.win ul.wrows { margin:0; padding:0; list-style:none; border-top:1px solid var(--rule2); }
.ck.win .wrow { display:grid; gap:4px; padding:8px 12px; border-bottom:1px solid var(--rule2); cursor:pointer; font-size:var(--fs-s); }
.ck.win .wrow.cur { background:var(--sunk); }
.ck.win .wrow .wl1 { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:baseline; justify-content:space-between; }
.ck.win .wrow .wl2, .ck.win .wrow .wl3 { font-size:var(--fs-xs); overflow-wrap:anywhere; }
.ck.win .wrow .wl3 { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.ck.win .wbot { border:0; background:none; padding:0; font:inherit; font-weight:600; color:var(--ink); text-align:left; text-decoration:underline; text-underline-offset:2px; cursor:pointer; }
.ck.win .watch .rrow { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; padding:8px 12px; font-size:var(--fs-s); }
.ck.win .watch .rrow + .rrow { border-top:1px solid var(--rule2); }
.ck.win .watch ul.rows { margin:0; padding:0; list-style:none; }
.ck.win .watch .rrow > :last-child { font-size:var(--fs-xs); overflow-wrap:anywhere; }
.ck.win .watch .rrow > .at { white-space:nowrap; }
/* 読めない理由は長いことがあるので、経路名の幅を奪わないよう次の段に置く。 */
.ck.win .watch .rrow > .hotc { grid-column:1 / -1; }
.ck.win .watch p { margin:0; font-size:var(--fs-s); }
.ck.win .watch .strips { margin:0; background:none; }
/* 届いた連絡の題は、見張るの見出しより弱くする（見出し → 小見出し → 項目の順）。 */
.ck.win .watch .strip .title { font-size:var(--fs-m); font-weight:400; }

/* 全体の右: タスクの詳細 */
.ck.win .wk2 { display:flex; flex-wrap:wrap; gap:8px 8px; align-items:center; }
.ck.win .lc { display:grid; grid-template-columns:3.4em minmax(0,1fr) auto; gap:8px; align-items:baseline; width:100%; text-align:left; border:0; background:none; padding:4px 8px; margin:0 -8px; border-radius:5px; font:inherit; color:inherit; }
.ck.win button.lc:hover { background:var(--sunk); }
.ck.win .lc .ti { overflow-wrap:anywhere; }
.ck.win .lc .mut { font-size:var(--fs-xs); white-space:nowrap; max-width:16em; overflow:hidden; text-overflow:ellipsis; }
/* 済んだカードは弱く、要対応・修正待ちだけを目立たせる。 */
.ck.win .lc.cl, .ck.win .lc.cl .kd { color:var(--ink3); font-weight:400; }
.ck.win .lc .kd.hotc { color:var(--hot); }
.ck.win .rqd { display:grid; gap:8px; }
.ck.win .rqd .code, .ck.win .tid { margin-right:8px; }
.ck.win .rqd .rst { white-space:nowrap; margin-left:8px; color:var(--ink3); font-size:var(--fs-xs); }
.ck.win .lc .now { font-size:var(--fs-xs); font-weight:700; color:var(--focus); white-space:nowrap; }
/* タスクの事実はラベルを左、値を右にそろえる。 */
.ck.win .facts .fld { grid-template-columns:6.5em minmax(0,1fr); gap:12px; align-items:baseline; }
.ck.win .facts .fld > .lb { font-size:var(--fs-xs); }
/* 狭い幅では見出しを値の上に置き、値の列の幅を取る（Neon 初見 2 巡目）。 */
@media (max-width:1100px) { .ck.win .facts .fld { grid-template-columns:minmax(0,1fr); gap:4px; } }
.ck.win .kl .num { margin:0 .3em; }
.ck.win .rqd + .rqd { border-top:1px solid var(--rule2); padding-top:8px; margin-top:4px; }
.ck.win .dw { margin:0; padding:0; list-style:none; display:grid; gap:4px; }
.ck.win .dw li { display:grid; grid-template-columns:1.6em minmax(0,1fr); align-items:baseline; color:var(--ink); }
.ck.win .dw li.ok { color:var(--ink2); }
/* 済の条件のチェックの形。済は塗り、未は枠だけ。 */
.ck.win .dw .cb { width:12px; height:12px; border:1.5px solid var(--ink3); border-radius:2px; display:inline-block; position:relative; top:1px; }
.ck.win .dw li.ok .cb { background:var(--ink2); border-color:var(--ink2); }
.ck.win .dw li.ok .cb::after { content:""; position:absolute; left:3px; top:0; width:3px; height:7px; border:solid var(--surface); border-width:0 2px 2px 0; transform:rotate(45deg); }
.ck.win .purp { margin:8px 16px 0; font-size:var(--fs-s); color:var(--ink2); line-height:1.6; }
.ck.win .recm { display:block; min-width:0; font-size:var(--fs-xs); color:var(--ink2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ck.win details.cont summary { cursor:pointer; font-size:var(--fs-xs); color:var(--focus); padding:4px 0; }
.ck.win .ntr { font-size:var(--fs-s); color:var(--ink2); }
.ck.win .ntr summary { cursor:pointer; color:var(--focus); }
.ck.win .ntr ul { margin:4px 0 0; padding:0; list-style:none; display:grid; gap:4px; font-size:var(--fs-s); }
.ck.win .ntr .code { margin-right:8px; }
.ck.win .ntr .rst { white-space:nowrap; margin-left:8px; color:var(--ink3); font-size:var(--fs-xs); }
.ck.win .wk2 + .wk2 { margin-top:4px; }
/* 出した指示（新しい順） */
.ck.win .wdet > .sent { margin:8px 16px 0; }
.ck.win .sent ol { margin:0; padding:0; list-style:none; display:grid; }
.ck.win .sent li { display:grid; gap:4px; padding:4px 0; font-size:var(--fs-s); }
.ck.win .sent li + li { border-top:1px solid var(--rule2); }
.ck.win .sent button.code { border:0; background:none; padding:0; font:inherit; color:inherit; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
.ck.win .sent .sl { display:flex; flex-wrap:wrap; gap:4px 8px; align-items:center; }
.ck.win .sent .tm { font-size:var(--fs-xs); color:var(--ink3); font-variant-numeric:tabular-nums; min-width:8.5em; }
/* 1366 以下では操作の帯のキーの説明を外し、「次へ」まで 1 行に収める。 */
@media (max-width:1366px) { .ck.win .dbtn .acts .hint { display:none; } }
`
