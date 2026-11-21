export const CSS = `
:root { color-scheme: light;
  /* Orca のテーマに関係なく白地で描く（暗い地では読みにくいという利用者の判断）。--orca-* には頼らない。 */
  --ck-background:#ffffff; --ck-foreground:#1b1d21; --ck-muted:#f4f4f1; --ck-muted-foreground:#666a71;
  --ck-accent:#f4f4f1; --ck-accent-foreground:#1b1d21; --ck-secondary:#efefeb; --ck-border:#e3e3de;
  --ck-ring:#2557c5; --ck-primary:#1b1d21; --ck-primary-foreground:#ffffff; --ck-radius:4px;
  background:var(--ck-background); }
body { margin:0; background:var(--ck-background); }
.ck { --ok:#2f7a4a; --run:#2557c5; --stop:#8a1c14; --wait:#a15c07; --idle:#7a7e85;
      /* 朱は期限が 24 時間以内か過ぎた項目だけに使う。 */
      --hot:#d1361b; --paper2:#f8f8f6; --line-strong:#1b1d21;
      /* 文字の大きさは 4 種類。 */
      --fs-title:20px; --fs-head:15.5px; --fs-body:13.5px; --fs-note:12.5px;
      --mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace;
      /* 外部のフォントは読み込まない（パネルは Orca のサンドボックス）。IBM Plex Sans JP は Mac に入れておき、無ければヒラギノ。 */
      font-family:"IBM Plex Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN",-apple-system,system-ui,sans-serif;
      background:var(--ck-background); color:var(--ck-foreground);
      font-size:var(--fs-body); line-height:1.6; font-variant-numeric:tabular-nums; container-type:inline-size;
      -webkit-font-smoothing:antialiased; }
.ck * { box-sizing:border-box; }
.ck button { font:inherit; cursor:pointer; color:inherit; }
.ck button:disabled { cursor:default; }
.ck :focus-visible { outline:2px solid var(--ck-ring); outline-offset:1px; }
.ck [hidden] { display:none !important; }
.ck .vh { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; margin:0; }
.ck .mut { color:var(--ck-muted-foreground); }
.ck .num { font-variant-numeric:tabular-nums; }
.ck .mono { font-family:var(--mono); }
.ck .note { font-size:var(--fs-note); }

/* ── この案件の帯 ── */
.ck .bar { display:grid; gap:2px; padding:12px 18px 10px; border-bottom:1px solid var(--ck-border); }
.ck .bar .l3 { display:flex; gap:4px 16px; flex-wrap:wrap; font-size:var(--fs-note); align-items:center; }
.ck .brk { color:var(--ck-muted-foreground); font-weight:400; }
.ck .warn { color:var(--wait); font-weight:600; }
.ck .over { color:var(--hot); font-weight:700; white-space:nowrap; }
.ck .chip { display:inline-flex; align-items:center; gap:6px; font-size:var(--fs-note); border:1px solid var(--ck-border); border-radius:3px; padding:0 8px; white-space:nowrap; }
.ck .chip.bad { border-color:var(--wait); }
.ck .chip.bad.hard { border-color:var(--stop); }

.ck .st { display:inline-grid; place-items:center; width:12px; flex:none; font-size:var(--fs-note); line-height:1; }
.ck .s-ok{color:var(--ok)} .ck .s-run{color:var(--run)} .ck .s-stop{color:var(--stop)} .ck .s-wait{color:var(--wait)} .ck .s-idle{color:var(--idle)}

.ck .tabs { display:flex; gap:4px; padding:0 14px; border-bottom:1px solid var(--ck-border); flex-wrap:wrap; }
.ck .tab { background:none; border:0; border-bottom:2px solid transparent; padding:8px 8px 6px; font-size:var(--fs-body); color:var(--ck-muted-foreground); }
.ck .tab[aria-selected="true"] { color:var(--ck-foreground); border-bottom-color:var(--line-strong); font-weight:700; }
.ck .keys { margin-left:auto; align-self:center; font-size:var(--fs-note); }
.ck .keyhint { margin-left:auto; align-self:center; background:none; border:1px solid var(--ck-border); border-radius:50%; width:24px; height:24px; padding:0; font-size:var(--fs-note); color:var(--ck-muted-foreground); }
.ck .keys + .keyhint { margin-left:8px; }
.ck .tabs .repeat { margin-left:auto; align-self:center; }
.ck .tabs .repeat + .keyhint, .ck .tabs .repeat + .keys { margin-left:8px; }
.ck kbd { font-family:var(--mono); font-size:var(--fs-note); border:1px solid var(--ck-border); border-radius:3px; padding:0 4px; }

.ck .notes { display:grid; gap:4px; padding:6px 18px; border-bottom:1px solid var(--ck-border); font-size:var(--fs-note); background:var(--paper2); }
.ck .notes .err { color:var(--stop); }
.ck .notes .row2 { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }

/* ── この案件の残り（一覧）と、選んだ項目（詳細） ── */
.ck .split { display:grid; grid-template-columns:minmax(260px,380px) 1fr; min-height:420px; }
@container (max-width:760px){ .ck .split { grid-template-columns:1fr; } .ck .detail { border-left:0 !important; border-top:1px solid var(--ck-border); } }
.ck .list { padding:4px 0 12px; }
.ck .row { display:grid; grid-template-columns:auto minmax(8em,1fr) auto; gap:10px; width:100%; text-align:left; background:none; border:0; padding:8px 18px; border-left:3px solid transparent; }
.ck .row:hover { background:var(--ck-accent); }
.ck .row[aria-current="true"] { background:var(--ck-secondary); border-left-color:var(--line-strong); }
.ck .row .t { font-weight:600; word-break:auto-phrase; }
.ck .row .s { font-size:var(--fs-note); }
/* 一覧の行の下の説明（関係するタスク）は 1 行で切り、行を縦に伸ばさない。 */
.ck .irow .s { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* 長い期限（! あと n 時間 と日時）は題名を潰さず、空白で折り返す。 */
.ck .irow { grid-template-columns:1fr; gap:2px; }
.ck .irow .rhead { display:flex; flex-wrap:wrap; gap:2px 10px; align-items:center; }
.ck .row .due { font-size:var(--fs-note); }
/* 種類の印。墨色の枠と文字。期限が近いものだけ朱で塗る。 */
.ck .kind { display:inline-grid; place-items:center; min-width:3.6em; height:22px; padding:0 6px; border:1px solid var(--line-strong); border-radius:2px;
            font-size:var(--fs-note); line-height:1; font-weight:600; color:var(--ck-foreground); background:var(--ck-background); white-space:nowrap; margin-top:1px; }
.ck .kind.k-ask { border-style:dashed; }
.ck .kind.k-ack { border-color:var(--ck-border); color:var(--ck-muted-foreground); }
.ck .kind.k-req { border-color:var(--ck-muted-foreground); color:var(--ck-muted-foreground); }
.ck .kind.hot { background:var(--hot); border-color:var(--hot); color:#fff; }

.ck .detail { border-left:1px solid var(--ck-border); padding:18px 24px 24px; min-width:0; }
.ck .detail h2 { font-size:var(--fs-title); line-height:1.4; margin:2px 0 6px; font-weight:700; letter-spacing:.01em; }
.ck .meta { font-size:var(--fs-note); display:flex; gap:4px 12px; align-items:center; flex-wrap:wrap; }
.ck .meta .crumb { color:var(--ck-muted-foreground); }
.ck .goal { font-size:var(--fs-body); margin-top:6px; }
.ck .goal .lbl, .ck .ask1 .mut:first-child { font-size:var(--fs-note); font-weight:700; color:var(--ck-foreground); margin-right:10px; }
.ck .sec { margin-top:16px; }
/* 見出しは本文より強く（墨色・太字）。節の見出しは一回り大きく、欄の見出しは本文と同じ大きさ。灰色は見出しの後ろの説明だけ。 */
.ck .sec > .h { font-size:var(--fs-head); font-weight:700; line-height:1.4; margin-bottom:6px; color:var(--ck-foreground); }
.ck .ctxbody .sec > .h, .ck .morebody .sec > .h { font-size:var(--fs-body); margin-bottom:2px; }
.ck .opt { display:grid; grid-template-columns:24px 1fr; gap:10px; width:100%; text-align:left; background:var(--ck-background); border:1px solid var(--ck-border); border-radius:var(--ck-radius); padding:9px 12px; margin-top:6px; }
.ck button.opt:hover { border-color:var(--ck-muted-foreground); }
.ck .opt.rec { border-left:3px solid var(--ok); }
.ck .opt[aria-pressed="true"] { border-color:var(--line-strong); box-shadow:inset 0 0 0 1px var(--line-strong); background:var(--paper2); }
.ck .opt .key { font-family:var(--mono); font-size:var(--fs-note); border:1px solid var(--ck-border); border-radius:3px; height:22px; display:grid; place-items:center; color:var(--ck-muted-foreground); }
.ck .opt .ex { font-size:var(--fs-note); margin-top:2px; color:var(--ck-foreground); }
.ck .opt .exl { color:var(--ck-muted-foreground); margin-right:8px; }
.ck .badge { font-size:var(--fs-note); padding:0 6px; margin-left:8px; font-weight:600; }
.ck .b-rec { color:var(--ok); }
.ck .b-took { color:var(--run); }
.ck blockquote { margin:6px 0 0; padding:2px 12px; border-left:2px solid var(--ck-border); font-size:var(--fs-note); color:var(--ck-muted-foreground); }
.ck blockquote.orig { font-size:var(--fs-body); color:var(--ck-foreground); border-left-color:var(--line-strong); }
.ck .fallback { margin-top:12px; font-size:var(--fs-note); padding:8px 12px; background:var(--ck-muted); }

/* 詳細の欄（既定では閉じる） */
.ck .morebox { margin-top:14px; border-top:1px solid var(--ck-border); }
/* 決めるための情報は、決めるのにまず要るので開いた状態で、選択肢より上に置く。欠けた欄は茶の枠で名指しする（朱は期限だけに使う）。 */
.ck .whynow { margin-top:10px; }
.ck .ctxbox { margin-top:10px; border-top:1px solid var(--ck-border); }
/* 5 欄は左の線で一つの塊にし、欄の間を区切り線で分ける。 */
.ck .ctxbody { margin:2px 0 0 5px; padding-left:14px; border-left:2px solid var(--ck-border); }
.ck .ctxbody > .sec { margin:0; padding:8px 0 10px; }
.ck .ctxbody > .sec + .sec { border-top:1px solid var(--ck-border); }
.ck .lackbox { margin-top:10px; font-size:var(--fs-note); padding:6px 10px; border:1px solid var(--wait); color:var(--wait); }
.ck .morebtn { display:flex; gap:8px; align-items:baseline; width:100%; background:none; border:0; padding:10px 0 4px; text-align:left; font-weight:700; font-size:var(--fs-head); line-height:1.4; }
.ck .morebtn .mut { font-weight:400; font-size:var(--fs-note); }
.ck .morebtn .tri { width:12px; color:var(--ck-muted-foreground); }
.ck .morebody { padding-left:20px; }
.ck .morebody .sec:first-child { margin-top:6px; }
.ck table.cmp { border-collapse:collapse; font-size:var(--fs-note); margin-top:2px; }
.ck table.cmp th, .ck table.cmp td { border-bottom:1px solid var(--ck-border); padding:6px 14px 6px 0; text-align:left; vertical-align:top; }
.ck table.cmp thead th { font-weight:700; border-bottom-color:var(--line-strong); }
.ck table.cmp tbody th { font-weight:600; white-space:nowrap; }

/* 返答の列 */
.ck .acts { display:flex; gap:8px 10px; flex-wrap:wrap; align-items:center; margin-top:16px; }
.ck .fbline { font-size:var(--fs-note); margin-top:14px; }
.ck .acts > .opens { flex-basis:100%; margin:0; }
.ck .acts .jump { margin-left:auto; }
.ck .btn { border:1px solid var(--ck-border); background:var(--ck-background); border-radius:var(--ck-radius); padding:6px 14px; font-size:var(--fs-body); white-space:nowrap; }
.ck .btn:hover:not(:disabled) { border-color:var(--ck-muted-foreground); }
.ck .btn.pri { background:var(--ck-primary); color:var(--ck-primary-foreground); border-color:var(--ck-primary); font-weight:600; }
.ck .btn.pri:disabled { background:var(--ck-background); color:var(--ck-muted-foreground); border:1px dashed var(--ck-border); font-weight:400; }
.ck .btn.sm { padding:1px 8px; font-size:var(--fs-note); }
.ck .btn.open { display:inline-flex; gap:8px; align-items:center; border-color:var(--line-strong); font-weight:600; }
.ck .fixbox { margin-top:10px; padding:10px 12px; border:1px solid var(--line-strong); font-size:var(--fs-note); display:grid; gap:8px; }
.ck .fixbox .mut { margin-left:8px; }
.ck .copyrow { display:flex; gap:8px; }
.ck .copytext { flex:1; min-width:0; font:inherit; font-size:var(--fs-note); padding:3px 8px; border:1px solid var(--ck-border); border-radius:3px; background:var(--paper2); }

/* 送る文面。送る見た目に近い枠。長いときは枠の中だけ動かす。 */
.ck .dbox { border:1px solid var(--ck-border); border-left:3px solid var(--line-strong); background:var(--paper2); }
.ck .dto { font-size:var(--fs-note); padding:6px 12px; border-bottom:1px solid var(--ck-border); }
.ck .dto .mut { margin-right:10px; }
.ck .dtext { white-space:pre-wrap; overflow-wrap:anywhere; padding:8px 12px; max-height:15em; overflow-y:auto; }
.ck .dacts { display:flex; gap:8px 12px; align-items:center; flex-wrap:wrap; margin-top:6px; }
.ck .links { display:flex; flex-wrap:wrap; gap:4px 0; margin-top:12px; }
.ck .ilnk { background:none; border:0; padding:0; font:inherit; text-decoration:underline; text-underline-offset:3px; color:var(--run); }
.ck .rt-box p.rtp { margin:0 0 4px; }
.ck .rt-box .rth { font-weight:700; margin:8px 0 2px; }
.ck ul.rt, .ck ol.rt { margin:2px 0 6px; padding-left:1.5em; }
.ck ul.rt li, .ck ol.rt li { padding:1px 0; }
.ck .rt ul.rt, .ck .rt ol.rt { margin:2px 0 2px; }
.ck .rt-box strong { font-weight:700; }
.ck code { font-family:var(--mono); font-size:.92em; background:var(--ck-muted); border-radius:3px; padding:0 4px; }
.ck pre.rtcode { margin:4px 0 6px; padding:8px 12px; background:var(--ck-muted); border-radius:var(--ck-radius); overflow-x:auto; font-size:var(--fs-note); line-height:1.5; }
.ck pre.rtcode code { background:none; padding:0; font-size:inherit; }
.ck blockquote.rtq { margin:4px 0 6px; font-size:var(--fs-body); color:var(--ck-foreground); }

/* 話したいこと（項目ごとのやり取り） */
.ck .talk { border-top:1px solid var(--ck-border); padding-top:10px; }
.ck .msg { margin-top:8px; padding:8px 12px; max-width:52em; border-radius:var(--ck-radius); }
.ck .msg .who { font-size:var(--fs-note); font-weight:600; display:flex; gap:8px; align-items:baseline; }
.ck .msg .who .mut { font-weight:400; }
.ck .msg .txt { margin-top:2px; }
.ck .msg.me { background:var(--paper2); border:1px solid var(--ck-border); margin-left:auto; }
.ck .msg.ai { border:1px solid var(--ck-border); border-left:3px solid var(--run); }
.ck .msg.main { border:1px solid var(--ck-border); border-left:3px solid var(--line-strong); }
.ck .msg.failed { border-left-color:var(--wait); }
.ck .msg.wait { border-style:dashed; border-left-width:1px; }
.ck .msg.sys { font-size:var(--fs-note); padding:2px 0; }
.ck .msgacts { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:6px; font-size:var(--fs-note); }
.ck .chatin { margin-top:10px; display:grid; gap:6px; }
/* 別の答え: 1 行で出し、書くと広がる。話したい（質問）と並ぶので、見出しの説明で違いを示す。 */
.ck .sec > .h .mut { font-weight:400; font-size:var(--fs-note); }
.ck .count { font-size:var(--fs-note); color:var(--ck-muted-foreground); white-space:nowrap; }
.ck .count.over-limit { color:var(--wait); font-weight:700; }
.ck .sec.other .count { display:block; margin-top:2px; }
.ck .otherin { display:flex; gap:8px; align-items:flex-start; }
.ck .otherin textarea { flex:1; font:inherit; resize:none; padding:6px 10px; border:1px solid var(--line-strong); border-radius:var(--ck-radius); field-sizing:content; min-height:2.2em; max-height:10em; }
.ck .chatin textarea { font:inherit; width:100%; resize:vertical; padding:8px 10px; border:1px solid var(--line-strong); border-radius:var(--ck-radius); min-height:4.8em; }
.ck .chatacts { display:flex; gap:10px; align-items:center; justify-content:space-between; font-size:var(--fs-note); }
.ck .fixhint { font-size:var(--fs-note); }
.ck .fixhint .mut { margin-left:8px; }

/* 図。詳細の欄の幅いっぱい。字が小さく描かれた図は押すと拡大する。 */
.ck .fig.zoomable { cursor:zoom-in; position:relative; }
.ck .fig.zoomable::after { content:"押すと拡大"; position:absolute; right:0; top:0; font-size:var(--fs-note); background:var(--ck-background); border:1px solid var(--ck-border); padding:0 6px; color:var(--ck-muted-foreground); }
.figzoom { position:fixed; inset:0; z-index:10; background:var(--ck-background); display:grid; place-items:center; overflow:auto; cursor:zoom-out; padding:24px; }
.figzoom .fzin svg { width:100%; height:auto; display:block; }

/* 見て */
.ck .ask1 { margin-top:8px; }
.ck ol.look { margin:0; padding-left:1.4em; }
.ck ol.look li { padding:1px 0; }
.ck .opens { display:grid; gap:8px; }
.ck .dl { display:flex; gap:6px 12px; align-items:center; flex-wrap:wrap; }

/* リンク。種類の印（Drive・PR・ページ・ファイル）を前に付ける。 */
.ck .lnk { display:inline-flex; gap:6px; align-items:baseline; background:none; border:0; padding:0; text-align:left; text-decoration:underline; text-underline-offset:3px; margin-right:12px; }
.ck .lk { font-size:var(--fs-note); font-weight:600; text-decoration:none; display:inline-block; border:1px solid var(--ck-border); border-radius:2px; padding:0 5px; line-height:1.4; color:var(--ck-muted-foreground); }
.ck .src { font-size:var(--fs-note); margin-top:14px; }
.ck .src .lnk { font-size:var(--fs-note); }
.ck table.mini { width:100%; border-collapse:collapse; margin-top:4px; }
.ck table.mini td { border-top:1px solid var(--ck-border); padding:6px 4px; vertical-align:top; }
.ck table.mini td:last-child { white-space:nowrap; text-align:right; width:1%; }
.ck .tag { font-size:var(--fs-note); padding:0 6px; border:1px solid var(--wait); color:var(--wait); white-space:nowrap; border-radius:2px; }

.ck .empty { padding:48px 16px; text-align:center; }
.ck .empty .big { font-size:var(--fs-head); font-weight:700; }
.ck .empty code { font-family:var(--mono); font-size:var(--fs-note); background:var(--ck-muted); padding:2px 6px; border-radius:3px; }

.ck .link { background:none; border:0; padding:0; font-size:var(--fs-note); text-decoration:underline; text-underline-offset:3px; color:var(--ck-muted-foreground); }

.ck .toast { position:sticky; bottom:12px; margin:0 auto; width:max-content; max-width:92%; display:flex; gap:12px; align-items:center;
             background:var(--ck-foreground); color:var(--ck-background); border-radius:var(--ck-radius); padding:7px 14px; font-size:var(--fs-body); z-index:2; }
.ck .toast button { background:none; border:0; color:inherit; text-decoration:underline; }
@media (prefers-reduced-motion:no-preference){ .ck .row { transition:background .12s; } }
.ck svg text { font-family:inherit; }
.ck .fig { max-width:100%; }
.ck .fig svg { width:100%; height:auto; display:block; }
.ck .tlink { background:none; border:0; padding:0; text-decoration:underline; text-underline-offset:3px; font-weight:600; text-align:left; }
.ck .tlink[aria-current="true"] { text-decoration-thickness:2px; }
.ck .reqs ul.rel li { padding-left:8px; gap:2px 8px; }
.ck .side-sec ul.rel .num { font-size:var(--fs-note); }
.ck .reqs li:has(.tlink[aria-current="true"]) { background:var(--ck-secondary); box-shadow:inset 3px 0 0 var(--line-strong); }
.ck ul.rel, .ck ul.plain { list-style:none; margin:4px 0 0; padding:0; }
.ck ul.rel li { display:flex; align-items:center; gap:6px 10px; flex-wrap:wrap; padding:4px 0; }
.ck ul.plain li { padding:2px 0; }
.ck ul.plain li::before { content:"・"; color:var(--ck-muted-foreground); }
.ck .eff { font-size:var(--fs-note); padding:0 6px; background:var(--ck-muted); border-radius:2px; }
.ck .stb { font-size:var(--fs-note); font-weight:400; margin-left:8px; color:var(--ck-muted-foreground); white-space:nowrap; }
.ck .more { display:block; background:none; border:0; padding:8px 18px 0; font-size:var(--fs-note); color:var(--ck-muted-foreground); text-decoration:underline; text-underline-offset:3px; }

/* ── 全体 ── */
.ck .whole-top { padding:14px 18px; border-bottom:1px solid var(--ck-border); display:grid; gap:14px; overflow-x:auto; }
.ck .whole-top .h { font-size:var(--fs-head); font-weight:700; line-height:1.4; margin-bottom:4px; }
.ck .rs { font-size:var(--fs-note); padding:0 6px; border:1px solid var(--ck-border); border-radius:2px; white-space:nowrap; }
.ck .rs-review { border-color:var(--line-strong); font-weight:600; }
.ck .rs-accepted { border-color:var(--ok); color:var(--ok); }
.ck .rs-done { color:var(--ck-muted-foreground); }
.ck .msl { list-style:none; margin:0; padding:0; font-size:var(--fs-note); }
.ck .msl li { display:grid; grid-template-columns:7.5em 6em 1fr; gap:4px 10px; padding:2px 0; }
.ck .msl .msd { color:var(--ck-muted-foreground); }
.ck .msl .msd.today { color:var(--hot); font-weight:700; }
.ck .await { font-size:var(--fs-note); }
.ck .stb .st { margin-right:4px; }

/* 大タスク・タスク・依頼の画面（全体のタブの中の 1 列）。 */
.ck .whole-top.wpage { padding:0; border-bottom:0; display:block; }
.ck .whole-top.wpage > .detail { border:0 !important; }
.ck .crumbs { font-size:var(--fs-note); color:var(--ck-muted-foreground); display:flex; flex-wrap:wrap; gap:2px 6px; align-items:baseline; margin-bottom:6px; }
.ck .crumbs .tlink { font-weight:400; }
.ck .crumbs .here { color:var(--ck-foreground); font-weight:700; }
.ck .crumbs .tag { font-weight:400; }
.ck .also { font-size:var(--fs-note); color:var(--ck-muted-foreground); display:flex; flex-wrap:wrap; gap:2px 10px; margin:-2px 0 8px; }
.ck .also .tlink { font-weight:400; }
.ck .backbar { display:flex; flex-wrap:wrap; align-items:center; gap:4px 12px; padding:6px 10px; margin-bottom:12px; border:1px solid var(--line-strong); border-radius:var(--ck-radius); background:var(--paper2); font-size:var(--fs-note); }
.ck .nodesc { display:flex; flex-wrap:wrap; gap:4px 10px; align-items:baseline; margin-top:10px; padding:8px 12px; border:1px dashed var(--ck-border); font-size:var(--fs-note); }
.ck ul.tasks li { padding:6px 0; }
.ck .tgoal { flex-basis:100%; font-size:var(--fs-note); padding-left:22px; }
.ck ul.reqq li { align-items:baseline; }
.ck ul.reqq blockquote { flex-basis:100%; margin-top:2px; }
/* 要対応・対応済みの一覧の大タスクのまとまり。見出しは薄い地で、一覧を動かしても上に留まる。押すと大タスクの画面へ上がる。 */
/* まとまりの境目は墨の線、見出しと行の境目と行どうしの境目は薄い線で、区切りを目で追えるようにする。 */
.ck .sgrp + .sgrp { border-top:2px solid var(--line-strong); }
.ck .shead { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 12px; width:100%; text-align:left; background:var(--paper2); border:0; border-bottom:1px solid var(--ck-border);
             padding:9px 18px 7px; position:sticky; top:0; z-index:1; }
.ck .shead .shn { font-weight:700; line-height:1.45; }
.ck .shead .go { font-size:var(--fs-note); color:var(--run); white-space:nowrap; text-decoration:underline; text-underline-offset:3px; }
.ck .shead .shs { grid-column:1 / -1; display:flex; gap:6px; align-items:center; font-size:var(--fs-note); }
.ck button.shead:hover .shn { text-decoration:underline; text-underline-offset:3px; }
.ck .sgrp .row { border-bottom:1px solid var(--ck-border); }
.ck .sgrp .row:last-child { border-bottom:0; }

/* 全体。左に大タスクを手当ての要る順のまとまりで、右に節目・顧客への確認・依頼。 */
.ck .whole-top.ov { grid-template-columns:minmax(0,1fr); gap:24px 36px; padding:16px 18px 28px; border-bottom:0; align-items:start; }
@container (min-width:1000px) { .ck .whole-top.ov { grid-template-columns:minmax(0,1fr) 21rem; } .ck .ovside { border-left:1px solid var(--ck-border); padding-left:24px; } }
.ck .ovsec + .ovsec { margin-top:20px; }
.ck .ovh { display:flex; gap:6px; align-items:baseline; margin:0 0 6px; font-size:var(--fs-head); font-weight:700; line-height:1.4; }
.ck button.ovh { background:none; border:0; padding:0; color:var(--ck-muted-foreground); }
.ck button.ovh .tri { width:12px; }
/* 行ごとの列を揃えるため、列は一覧（ovl）で決め、行は subgrid で受ける。 */
.ck .ovl { list-style:none; margin:0; padding:0; border-top:1px solid var(--line-strong); display:grid; grid-template-columns:minmax(0,1fr) max-content max-content; column-gap:20px; }
.ck .ovl li { border-bottom:1px solid var(--ck-border); grid-column:1 / -1; display:grid; grid-template-columns:subgrid; }
.ck .ovr { display:grid; grid-column:1 / -1; grid-template-columns:subgrid; grid-template-areas:"n ph t" "now now now"; gap:2px 16px; align-items:baseline; width:100%; text-align:left; background:none; border:0; padding:9px 8px; }
.ck .ovr:hover { background:var(--ck-accent); }
.ck .ovr:hover .t { text-decoration:underline; text-underline-offset:3px; }
.ck .ovn { grid-area:n; display:flex; gap:8px; align-items:baseline; min-width:0; }
.ck .ovn .t { font-weight:600; }
.ck .ovsub { display:contents; }
/* 今の様子は名前の下に行の幅いっぱいで 2 行まで。 */
.ck .ovnow { grid-area:now; padding-left:20px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; font-size:var(--fs-note); color:var(--ck-muted-foreground); }
.ck .ovr > .pbar, .ck .ovsub > .pbar { grid-area:ph; }
.ck .ovt { grid-area:t; font-size:var(--fs-note); text-align:right; }
.ck .ovt b { white-space:nowrap; }
@container (max-width:760px) {
  .ck .ovl { grid-template-columns:minmax(0,1fr) auto; }
  .ck .ovr { grid-template-areas:"n t" "now now" "ph ph"; }
  .ck .ovr .pbar { padding-left:20px; }
}
.ck .ovside { display:grid; gap:22px; align-content:start; }
.ck .side-sec .h { font-size:var(--fs-head); font-weight:700; line-height:1.4; margin:0 0 4px; }
.ck .side-sec .h .mut { font-size:var(--fs-note); font-weight:400; }
/* 工程の進み。済んだ工程は灰、今の工程は墨で長く、まだの工程は枠だけ。 */
.ck .pbar { display:inline-flex; gap:8px; align-items:center; font-size:var(--fs-note); white-space:nowrap; }
.ck .pps { display:inline-flex; gap:2px; }
.ck .pp { display:block; width:10px; height:6px; border:1px solid var(--idle); border-radius:1px; }
.ck .pp.on { background:var(--idle); }
.ck .pp.cur { width:18px; background:var(--line-strong); border-color:var(--line-strong); }
.ck .ppl { margin-left:6px; white-space:normal; }

/* 大タスクの画面。今どうなっているか → あなたの対応 → タスク → 経緯と資料。 */
.ck .whole-top.wpage > .detail { max-width:72rem; }
.ck .detail h2.eph { text-wrap:balance; margin-bottom:8px; }
.ck .epstat { display:flex; flex-wrap:wrap; gap:6px 28px; align-items:center; }
.ck .epst { display:inline-flex; gap:6px; align-items:baseline; }
.ck .epnow { margin:6px 0 0; max-width:60em; }
/* 経過。日付・種類・中身の 3 列で、行の間に線を引く。今と次は地の色で分け、上の出来事と区別する。 */
.ck ol.tl { list-style:none; margin:0; padding:0; border-top:1px solid var(--ck-border); }
.ck .tle { display:grid; grid-template-columns:9.5em 7.5em minmax(0,1fr); gap:2px 12px; align-items:baseline; padding:6px 4px; border-bottom:1px solid var(--ck-border); }
.ck .tld { font-size:var(--fs-note); color:var(--ck-muted-foreground); white-space:nowrap; }
.ck .tlk { font-size:var(--fs-note); font-weight:600; }
.ck .tln { font-size:var(--fs-note); margin-left:10px; }
.ck .tle.now { background:var(--paper2); border-top:2px solid var(--line-strong); }
.ck .tle.now .tld, .ck .tle.next .tld { color:var(--ck-foreground); font-weight:700; }
.ck .tle.next { background:var(--paper2); }
.ck .tlnow { display:flex; flex-wrap:wrap; gap:0 8px; align-items:baseline; padding:1px 0; }
.ck .tlnow .tln { margin-left:0; }
.ck .tlnow + .tlnow { border-top:1px dashed var(--ck-border); }
@container (max-width:560px) { .ck .tle { grid-template-columns:auto minmax(0,1fr); } .ck .tle .tlt { grid-column:1 / -1; } }
.ck .lead { margin:12px 0 0; max-width:60em; text-wrap:pretty; }
.ck .lead .lbl { font-size:var(--fs-note); font-weight:700; margin-right:10px; }
.ck h3.h { margin:0 0 6px; }
.ck .epbox { margin-top:16px; padding:12px 16px 14px; border:1px solid var(--ck-border); border-left:3px solid var(--ck-border); }
.ck .epbox.hot { border-left-color:var(--line-strong); background:var(--paper2); }
.ck .epbox .h { font-size:var(--fs-head); font-weight:700; line-height:1.4; }
.ck .epbox p { margin:0; }
.ck .mlist { list-style:none; margin:0; padding:0; }
.ck .mlist li + li { border-top:1px solid var(--ck-border); }
.ck .mlist li { display:flex; flex-wrap:wrap; gap:0 12px; align-items:baseline; }
.ck .mrow { display:flex; gap:10px; align-items:baseline; background:none; border:0; padding:4px 0; text-align:left; }
.ck .mrow .t { font-weight:600; text-decoration:underline; text-underline-offset:3px; }
.ck .subh { font-size:var(--fs-note); font-weight:700; margin-top:10px; }
.ck .subh .mut { font-weight:400; }
.ck .tlist { list-style:none; margin:0; padding:0; border-top:1px solid var(--ck-border); }
.ck .tlist li { border-bottom:1px solid var(--ck-border); }
.ck .trow { display:grid; grid-template-columns:14px minmax(0,1fr) 7em 15em; gap:2px 12px; align-items:baseline; width:100%; background:none; border:0; text-align:left; padding:7px 4px; }
.ck .trow:hover { background:var(--ck-accent); }
.ck .trow .t { font-weight:600; }
.ck .trow:hover .t { text-decoration:underline; text-underline-offset:3px; }
.ck .trow .tph, .ck .trow .ts { font-size:var(--fs-note); }
@container (max-width:760px) { .ck .trow { grid-template-columns:14px minmax(0,1fr) auto; } .ck .trow .ts { grid-column:2 / -1; } }
/* 区分ごとに線と面で分ける。頭（題名・状態・ゴール）は墨の線で閉じ、あなたの対応は枠、ほかの区分は上に線、経緯と資料は薄い地の面。 */
.ck .ephead { padding-bottom:14px; border-bottom:2px solid var(--line-strong); }
.ck .epsec { margin-top:20px; padding-top:14px; border-top:1px solid var(--ck-border); }
.ck .epbox + .epsec { border-top:0; padding-top:0; }
.ck .story { background:var(--paper2); border:1px solid var(--ck-border); padding:12px 16px 14px; }
.ck .story .bgp + .bgp { border-top:1px solid var(--ck-border); padding-top:10px; }
.ck .story blockquote.orig { background:var(--ck-background); }
.ck .bgp + .bgp { margin-top:12px; }
.ck .lbl2 { font-size:var(--fs-note); font-weight:700; color:var(--ck-muted-foreground); margin-bottom:2px; }
.ck .wpage .more { padding-left:0; }
.ck .srcs { display:flex; flex-wrap:wrap; gap:4px 0; font-size:var(--fs-note); }
`
