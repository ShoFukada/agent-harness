// 見本のデータ（架空の案件・人・会社）。8 種類のカード・担当・顧客待ち・読めていない経路・Orca で止まった worker をそろえる。
// 期限は now からの相対で作り、いつ撮っても「期限切れ・今日・明日・今週・期限なし」がそろうようにする。テストと demo.ts が使う。
import type { Cockpit, UserLog } from '../src/model.ts'
import { REVIEW_SAMPLE } from './drafts.ts'

const H = 3_600_000
const iso = (t: number) => new Date(t).toISOString()
/** 今日の hh:mm（日本時間の手元の時計）。 */
const today = (now: number, h: number, m = 0) => {
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

export type SampleWs = { dir: string; cockpit: Cockpit; log: UserLog; figure?: string }

export function sample(now = Date.now()): SampleWs[] {
  const aoba: Cockpit = {
    version: 2,
    workspace: { name: '青葉物流 配車アプリ', milestones: [
      { date: iso(today(now, 15) + 2 * 24 * H), label: '定例（画面の確認と構成案の説明）' },
      { date: iso(today(now, 10) + 9 * 24 * H), label: 'stg で受入の試験を始める' }
    ] },
    main: { agent: 'claude', terminal: 'term_aoba_main' },
    streams: [
      { id: 's1', title: '配車画面の改修' },
      { id: 's2', title: 'AWS 構成案' },
      { id: 's3', title: '外部 API の繋ぎ込み' },
      { id: 's4', title: '定例と議事録' }
    ],
    tasks: [
      { id: 't1', stream: 's1', phase: '実装', title: '一覧の並べ替えと絞り込み', state: 'run', next: 'レビューの指摘を直して stg に出す', worker: { task_id: 'task_aoba_list', dispatch_id: 'ctx_aoba_list' } },
      { id: 't2', stream: 's2', phase: '設計', title: '構成案の図と本文', state: 'wait', next: '入口の描き方を決めてから送る版を作る' },
      { id: 't3', stream: 's3', phase: '設計', title: '利用上限の確認', state: 'wait', waiting_on: '森さん', waiting_since: iso(now - 50 * H), next: '回答が来たら繋ぎ込みの見積もり' },
      { id: 't4', stream: 's4', phase: '要件', title: '議事録の取りまとめ', state: 'ok' }
    ],
    owners: [
      { id: 'o1', title: 'AWS 構成案', stream: 's2', agent: 'claude', session: 'sess-aws' },
      { id: 'o2', title: '配車画面の改修', stream: 's1', agent: 'claude', terminal: 'term_aoba_w1' }
    ],
    routes: [{ id: 'slack', label: 'Slack #aoba-dev', read_at: iso(now - 12 * 60_000) }],
    cards: [
      {
        id: 'd21', rev: 1, kind: 'decide', state: 'open', at: iso(now - 5 * H), due: iso(now + 3 * H), stream: 's2',
        title: '構成案の本番の図に、社内向けの入口を描き足すか',
        purpose: '構成案の図が決まり、送る版を作れる',
        why: '送る版を明日の朝に出すので、今日中に図を決めたい。',
        context: {
          what: '構成案の p.9 の本番の構成図',
          now: '- 図は CloudFront 1 つだけ\n- 社内向けの入口（WAF つき）は p.11 の表にだけ書いてある',
          how: '- 描き足すなら、p.9 に CloudFront＋WAF（社内向け）を足す',
          gain: '入口が 2 つあることが図で一目で分かる',
          cost: '図が込み入り、p.9 の説明が 1 段落増える'
        },
        options: [
          { id: 'keep', label: '図はこのまま、本文で説明する', recommended: true, example: 'p.9 は CloudFront 1 つ、p.11 の表で入口 2 つを説明' },
          { id: 'draw', label: '図に社内向けの入口を描き足す', example: 'p.9 に CloudFront＋WAF（社内向け）が増える' }
        ],
        fallback: '決まるまで、送る版は今の図のまま作っておきます',
        figure: '.orca/cockpit/figures/entry.svg',
        background: { text: '森さんから「社内の人はどこから入るのか」と聞かれ、表だけでは伝わりにくいと分かった。', quote: '社内の人はどこから入る想定ですか？', date: iso(now - 30 * H) },
        links: [{ label: '構成案（Drive）', href: 'https://docs.google.com/presentation/d/example-aoba' }]
      },
      {
        id: 'd22', rev: 2, kind: 'send', state: 'open', at: iso(now - 26 * H), due: iso(now - 2 * H), stream: 's4',
        title: '議事録の共有をお願いする',
        purpose: '前回の定例で決めたことを、次の定例の前にそろえる',
        fallback: '今日中に返事が無ければ、定例の冒頭で口頭で確かめる',
        draft: {
          to: '森さん・林さん（Slack #aoba-dev の 11/19 のスレッド）', via: 'Slack',
          text: '@森 @林\nお疲れさまです。先日の定例の議事録の件、お手すきの際に共有いただけますと幸いです。\n次回の定例の前に、決めたことを一度そろえておきたいと考えています。',
          href: 'https://example.slack.com/archives/C000AOBA/p1700000000'
        }
      },
      {
        id: 'r5', rev: 1, kind: 'review', state: 'open', at: iso(now - 3 * H), due: iso(today(now, 18) + 24 * H), stream: 's1',
        title: '配車画面の一覧（並べ替えと絞り込み）',
        purpose: '一覧の改修を stg に出し、森さんの受入に回せる',
        fallback: '明日の定例までに返事が無ければ、stg に出したまま定例で見てもらう',
        request: '一覧で配送日と地区で並べ替え・絞り込みできるようにしてほしい。件数が多い日でも重くならないように',
        look_for: ['配送日の降順が既定になっている', '地区の絞り込みを外すと全件に戻る', '500 件の日でも 1 秒以内に出る'],
        evidence: ['stg の 500 件の日で 0.4 秒', '並べ替えと絞り込みの試験 12 件が通った'],
        href: 'https://github.com/example/aoba-dispatch/pull/42', diff: 'https://github.com/example/aoba-dispatch/pull/42/files'
      },
      {
        id: 'i3', rev: 1, kind: 'inbox', state: 'open', at: iso(now - 40 * 60_000), stream: 's1',
        title: '地図の表示が遅いという報告',
        from: { who: '森さん', via: 'Slack #aoba-dev', at: iso(now - 45 * 60_000), href: 'https://example.slack.com/archives/C000AOBA/p1700000100' },
        asked: '朝の時間帯に地図が出るまで 10 秒かかる。直るか',
        routed: '担当「配車画面の改修」が調べ始めた。返事は要る（担当が下書きを作る）',
        reply: 'needed'
      },
      {
        id: 'c4', rev: 3, kind: 'talk', state: 'open', at: iso(now - 20 * H), stream: 's2',
        title: 'AWS アカウントの分け方（1 つか、分けるか）',
        purpose: '構成案の前提（アカウントの数）を決め、見積もりを出せる',
        why: '森さんの回答が明日の午前に来るので、その前に考えをそろえたい',
        fallback: '話せないまま回答が来たら、担当の今の考えで進めて構成案に書く',
        quote: 'アカウントは本番と検証で分けたほうがいいですか？',
        last: { text: '森さんに送った内容で、あとは回答次第で決める感じにしよう。', at: iso(now - 19 * H), by: '私' },
        next: '森さんの回答（明日の午前）を待つ'
      },
      {
        id: 'w1', rev: 2, kind: 'send', state: 'waiting', at: iso(now - 60 * H), stream: 's3',
        title: '外部 API の利用上限を問い合わせた',
        draft: { to: '森さん（メール）', text: '外部 API の 1 日あたりの上限を教えてください。' },
        awaiting: { who: '森さん', what: '外部 API の利用上限の回答', since: iso(now - 50 * H), resumes: '外部 API の繋ぎ込みの見積もり', remind_at: iso(now - 4 * H) }
      },
      {
        id: 'd19', rev: 1, kind: 'decide', state: 'done', at: iso(now - 30 * H), stream: 's4',
        title: '定例の資料は作らず、議題だけテキストで送る',
        options: [{ id: 'text', label: '議題だけテキストで送る', recommended: true }, { id: 'deck', label: '資料を作る' }],
        resolved_by: 'user', resolved_at: iso(now - 26 * H), resolved_option: 'text'
      }
    ],
    applied_ops: [1]
  }

  const konan: Cockpit = {
    version: 2,
    workspace: { name: '港南病院 予約（運用保守）', milestones: [{ date: iso(today(now, 11) + 24 * H), label: '月次の報告会' }] },
    main: { agent: 'claude', terminal: 'term_konan_main' },
    streams: [
      { id: 'n112', title: 'No.112 確定メールの日付' },
      { id: 'n115', title: 'No.115 stg の調査' },
      { id: 'ops', title: '夜間の反映' }
    ],
    tasks: [
      { id: 'k1', stream: 'n112', phase: '受入', title: '本番への反映', state: 'wait', next: '本番の許可を待つ' },
      { id: 'k2', stream: 'n115', phase: '調査', title: 'stg の DB の接続', state: 'stop', next: '鍵を入れ直して再現する' },
      { id: 'k3', stream: 'ops', phase: '受入', title: 'No.110・111 を stg に出す', state: 'ok' }
    ],
    owners: [{ id: 'o5', title: 'No.115 stg の調査', stream: 'n115', agent: 'claude', terminal: 'term_konan_w2' }],
    routes: [
      { id: 'slack', label: 'Slack #konan-support', read_at: iso(now - 20 * 60_000) },
      { id: 'teams', label: 'Teams 病院の情報部', read_at: iso(now - 5 * H) }
    ],
    cards: [
      {
        id: 'p7', rev: 1, kind: 'permit', state: 'open', at: iso(now - 2 * H), due: iso(today(now, 18) > now ? today(now, 18) : now + 5 * H), stream: 'n112',
        title: 'No.112 の修正を本番に出す',
        purpose: '確定メールの日付の誤りを、今日の夜間の予約が入る前に直す',
        fallback: '18:00 までに返事が無ければ、明日の朝に出す',
        links: [{ label: '管理表の No.112', href: 'https://example.sharepoint.com/sites/konan/No112' }],
        target: 'release/2026-11-21（a1b2c3d..e4f5a6b）',
        effect: '予約の確定メールの日付の誤りが直る。止める時間はない',
        undo: '前のタグに戻す（5 分）', scope: '本番'
      },
      {
        id: 'k9', rev: 1, kind: 'stuck', state: 'open', at: iso(now - 3 * H), stream: 'n115', tasks: ['k2'],
        title: '担当「No.115 stg の調査」が、stg の DB に入れず止まっている',
        purpose: 'No.115 の不具合を stg で再現し、原因を確かめる',
        why: '情報部の返事を待つと、再現が明日以降になる',
        fallback: '返事が無ければ、情報部の返事を待つ',
        quote: 'stg の DB に入れません（担当の原文）',
        reason: 'FATAL: password authentication failed for user "app"', since: iso(now - 3 * H),
        answerable: true, unblock: 'stg の DB の鍵を入れ直してよいかを答える',
        options: [{ id: 'reset', label: '鍵を入れ直してよい', recommended: true, example: 'stg だけ。本番の鍵は触らない' }, { id: 'wait', label: '情報部の返事を待つ' }]
      },
      {
        id: 'a4', rev: 1, kind: 'report', state: 'open', at: iso(now - 9 * H), stream: 'ops',
        title: '夜のうちに No.110・111 を stg に出した',
        done: [
          { what: 'No.110（キャンセル待ちの順番）を stg に出した', why: '受入の試験を朝から始められるように', undo: 'stg のタグを 1 つ戻す' },
          { what: 'No.111 の文言を管理表どおりに直した', why: '情報部の指定の言い回しに合わせた', undo: '前の commit に戻す' },
          { what: '管理表の自社の列に反映日を書いた' }
        ]
      }
    ],
    applied_ops: []
  }

  const harness: Cockpit = {
    version: 2,
    workspace: { name: '社内ハーネス' },
    main: { agent: 'claude', terminal: 'term_h_main' },
    streams: [{ id: 'h1', title: 'ログ集計の見直し' }, { id: 'h2', title: '設計図のページ' }],
    tasks: [
      { id: 'u1', stream: 'h1', phase: '実装', title: '集計の分け方を直す', state: 'run', worker: { task_id: 'task_h_log', dispatch_id: 'ctx_h_log' } },
      { id: 'u2', stream: 'h2', phase: '実装', title: '流れと構成の図', state: 'ok' }
    ],
    cards: [
      {
        id: 'p9', rev: 1, kind: 'permit', state: 'open', at: iso(now - 6 * H), stream: 'h1', title: 'main の未 push の commit 12 件を push する',
        purpose: '窓の直しと hook の整理を、ほかの Mac でも使えるようにする', why: '明日の朝にほかの Mac で使うため', fallback: '返事が無ければ push せず、明日の朝にもう一度聞く',
        links: [{ label: '差分', href: 'https://github.com/example/harness/compare/ee74e11...9a40551' }],
        target: 'ee74e11..9a40551  main → origin/main', effect: '昨日からの窓の直しと hook の整理が入る', undo: 'push のあとは revert の commit で戻す', scope: 'push'
      },
      {
        id: 'r8', rev: 1, kind: 'review', state: 'open', at: iso(now - 8 * H), due: iso(today(now, 17) + 3 * 24 * H), stream: 'h2', title: '設計図のページ（流れと構成）',
        purpose: '担当と worker の分け方を 1 枚で説明できるようにする', fallback: '期限までに返事が無ければ、今の版で README から指す',
        request: '担当と worker の寿命と、窓・チャット・右の欄の役割を 1 枚の図にしてほしい',
        look_for: ['担当と worker の寿命の分け方が図で読める', '窓・チャット・右の欄の役割が 1 枚に収まる'],
        evidence: ['1440 幅と 390 幅で撮って、はみ出しが無いことを確かめた'], href: 'https://claude.ai/code/artifact/example'
      },
      {
        id: 'r9', rev: 1, kind: 'review', state: 'open', at: iso(now - 6 * H), due: iso(today(now, 17) + 3 * 24 * H), stream: 'h2', title: '送る前のコピーの書式（Slack・Teams・メール）',
        purpose: '窓からコピーした本文が、貼った先で箇条書き・太字・リンクのまま読めるか確かめる',
        request: '窓からコピーして、Slack・Teams・メールに貼って確かめられるようにしてほしい', fallback: '期限までに返事が無ければ、今の変換のまま使う',
        look_for: ['Slack に貼って、箇条書き・太字・リンクが崩れない', 'Teams に貼って、改行と箇条書きがそのまま', 'メールに貼って、素の文で読める'],
        evidence: ['3 つの書式でクリップボードに入る中身を試験で固定した'], draft: REVIEW_SAMPLE
      },
      {
        id: 'd30', rev: 1, kind: 'decide', state: 'open', at: iso(now - 7 * H), due: iso(now + 4 * 24 * H), stream: 'h1', title: '週次の振り返りを金曜 17:00 に固定するか',
        purpose: '振り返りの議題を担当が前日に用意できる', fallback: '決まるまで、週ごとに窓口が聞く', quote: '振り返りの時間が毎週ずれるのが面倒',
        context: { what: '週次の振り返りの時刻', now: '週ごとに窓口が聞いて決めている', how: '固定するなら、木曜の夜に担当が議題を用意する', gain: '毎週聞かれなくなる', cost: '金曜に外せない予定が入る週は動かす手間が出る' },
        options: [{ id: 'fix', label: '金曜 17:00 に固定する', recommended: true, example: '11/28(金) 17:00 から毎週' }, { id: 'free', label: '週ごとに決める', example: '今のまま、月曜に窓口が聞く' }]
      },
      {
        id: 'd28', rev: 1, kind: 'decide', state: 'open', at: iso(now - 30 * 60_000), stream: 'h1', title: 'push の許可を、この案件では任せるか',
        purpose: '毎回の push の許可を減らす', why: '今日だけで push の許可を 4 回聞いた', fallback: '決まるまで毎回聞く', quote: 'push くらいは任せてもいいかも',
        context: { what: 'このハーネスの main への push', now: '毎回「許す」で聞いている', how: '任せるなら、push したあとに報告だけを出す', gain: '許可の手間が無くなる', cost: '誤った commit の push に、あとから気づく' },
        options: [{ id: 'yes', label: '任せる（報告だけにする）', recommended: true, example: 'push のあとに報告のカードが 1 枚出る' }, { id: 'no', label: '毎回聞く', example: '今のまま「許す」が出る' }]
      }
    ],
    applied_ops: []
  }

  const hokuto: Cockpit = {
    version: 2,
    workspace: { name: '北斗電機 提案', milestones: [{ date: iso(today(now, 14) + 6 * 24 * H), label: '提案の説明会' }] },
    main: { agent: 'claude', terminal: '' },
    streams: [{ id: 'q1', title: '提案書の骨組み' }],
    tasks: [{ id: 'v1', stream: 'q1', phase: '要件', title: '骨組みを 15 ページに絞る', state: 'run' }],
    cards: [],
    applied_ops: []
  }

  return [
    { dir: 'aoba', cockpit: aoba, log: { ops: [{ op_id: 1, at: iso(now - 26 * H), item_id: 'd19', item_rev: 1, type: 'decide', option_id: 'text' }] }, figure: ENTRY_SVG },
    { dir: 'konan', cockpit: konan, log: { ops: [] } },
    { dir: 'harness', cockpit: harness, log: { ops: [] } },
    { dir: 'hokuto', cockpit: hokuto, log: { ops: [] } }
  ]
}

const ENTRY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 150" font-size="13">
<rect x="10" y="20" width="120" height="44" rx="6" fill="none" stroke="#7a8692"/><text x="70" y="47" text-anchor="middle">利用者</text>
<rect x="10" y="90" width="120" height="44" rx="6" fill="none" stroke="#7a8692"/><text x="70" y="117" text-anchor="middle">社内の人</text>
<rect x="210" y="20" width="140" height="44" rx="6" fill="none" stroke="#1f3a68" stroke-width="2"/><text x="280" y="47" text-anchor="middle">CloudFront</text>
<rect x="210" y="90" width="140" height="44" rx="6" fill="none" stroke="#9a6200" stroke-dasharray="5 4"/><text x="280" y="117" text-anchor="middle">CloudFront＋WAF</text>
<rect x="420" y="55" width="130" height="44" rx="6" fill="none" stroke="#7a8692"/><text x="485" y="82" text-anchor="middle">ECS（配車 API）</text>
<path d="M130 42H210M130 112H210M350 42L420 70M350 112L420 84" stroke="#7a8692" fill="none"/>
</svg>`

/** Orca にあって操縦席の無い作業場所（見ていない案件）。 */
export const UNSEEN = [{ dir: 'sandbox', name: '試し置き場' }, { dir: 'old-maint', name: '旧システムの保守' }]
