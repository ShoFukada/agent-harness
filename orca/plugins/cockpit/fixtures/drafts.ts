// 送る文面の見本（箇条書き・強調・リンク・改行を含む）。コピーの書式のテストと、貼った見た目を確かめるときに使う。架空の宛先。
import type { Draft } from '../src/model.ts'

const chat = `森さん
林さん

ご確認ありがとうございます。次の2点を直しました。
- **締切**: 11/25（月）18:00
- 手順書: [手順書（v2）](https://example.com/manual)

よろしくお願いいたします。
`

export const DRAFTS: Record<'slack' | 'teams' | 'mail', Draft> = {
  slack: { to: '森さん・林さん', via: 'Slack #aoba-dev', text: chat, href: 'https://example.slack.com/archives/C000AOBA/p1700000100' },
  teams: { to: '森さん・林さん', via: 'Teams のチャット', text: chat, href: 'https://teams.microsoft.com/l/message/19:x/1700000100' },
  mail: {
    to: '森様', via: 'メール', href: 'https://mail.google.com/mail/u/0/#inbox/abc',
    text: `件名: 【ご確認】手順書の修正について

森様

いつもお世話になっております。
次の2点を修正しました。
・【締切】11/25（月）18:00
・手順書: https://example.com/manual

よろしくお願いいたします。
`
  }
}

/** 見てのカードに持たせる、宛先ごとの書式で貼って確かめる見本（追加 25）。1 つの本文を 3 つの書式で写す。 */
export const REVIEW_SAMPLE: Draft = { to: '見本（Slack・Teams・メールに貼って確かめる）', text: chat }

/**
 * 書式の検査の実例（R161・R162）。旧 m1 は BW の送る前のカードで、Slack 宛てなのにメールの書式（■・「・」）で書かれ、そのまま Slack に下書き保存されたもの。
 * 直した m1 は書き直した後の版の頭、s163〜s165 は nix-darwin の操縦席で 3 つの宛先に貼って確かめた本文。顧客の値（人名・ID・アカウント番号・費用）は伏せた。
 */
const M1_ROUTE = { to: '先方の担当（システム部）', via: 'Slack #ex-先方の導入プロジェクトのスレッド（下書き保存済み）', href: 'https://example.slack.com/archives/C000BW/p1795000000000000' }
export const OLD_M1: Draft = {
  ...M1_ROUTE,
  text: `<@U00000000>
AWS の営業さんへのご確認ありがとうございます。いただいた 4 点にお答えします。

■ 必要なクォータ
・① Global cross-region model inference tokens per minute for Anthropic Claude Sonnet 5.5 だけで足ります。
・② は今のシステムでは使っていませんが、あわせて引き上げていただいても問題ありません
・対象は 3 アカウント（本番 000000000001・検証 000000000002・開発 000000000003）です`
}
export const FIXED_M1: Draft = {
  ...M1_ROUTE, format: 'slack',
  text: `<@U00000000>
AWS の営業さんへのご確認ありがとうございます。いただいた 4 点にお答えします。

**必要なクォータ**
- ① Global cross-region model inference tokens per minute for Anthropic Claude Sonnet 5.5 だけで足ります。システムは東京リージョン（ap-northeast-1）から、Global の推論プロファイル（global.anthropic.claude-sonnet-5-5）で呼んでいます
- ② は今のシステムでは使っていませんが、あわせて引き上げていただいても問題ありません
- 対象は 3 アカウント（本番 000000000001・検証 000000000002・開発 000000000003）です

**今の状況**
- お見込みのとおり、クレジットが足りないのではなく、Sonnet 5.5 を呼べない状況です
- 11/17 から暫定で Sonnet 4.6 で動かしているため、業務は止まっていません`
}
export const REAL_SENDS: Record<'s163' | 's164' | 's165', Draft> = {
  s163: {
    to: '深田さん自身への DM', via: 'Slack（Medurance）', format: 'slack', href: 'https://example.slack.com/team/U00000000',
    text: '**【テスト】送信前のカードのコピーの確認（Slack）**\n深田さん自身への DM です。誰にも届きません。\n\n確認したいこと\n- 箇条書きが「・」でなく箇条書きとして貼られる\n- **太字**が太字になる\n- 改行と空行がそのまま残る\n\nコマンドの例: `orca automations list --json`\nリンクの例: https://example.com/artifact\n\n以上です。'
  },
  s164: {
    to: '深田さん自身', via: 'メール（Gmail）', format: 'mail', href: 'https://mail.google.com/mail/u/0/#inbox?compose=new',
    text: '件名: 【テスト】送信前のカードのコピーの確認（メール）\n\n深田さん\n\n深田さん自身に宛てたテストのメールです。誰にも届きません。\n\n■確認したいこと\n・1行目の「件名:」の行が、本文ではなく件名に入れやすいか\n・箇条書きの「・」と改行がそのまま残る\n・【強調】の括弧が崩れない\n\nリンクの例: https://example.com/artifact\n\n以上、よろしくお願いいたします。\n深田'
  },
  s165: {
    to: '自分とのチャット', via: 'Teams', format: 'teams', href: 'https://teams.microsoft.com/v2/',
    text: '**【テスト】送信前のカードのコピーの確認（Teams）**\n自分とのチャット（メモ）への投稿です。誰にも届きません。\n\n確認したいこと\n- 箇条書きが箇条書きとして貼られる\n- **太字**が太字になる\n- 改行と空行がそのまま残る\n\nコマンドの例: `orca automations list --json`\n\n以上です。'
  }
}

/**
 * 試験用の偽の draft-format-lint（dev-standards の CLI と同じ入出力の契約）。Slack・Teams は行頭の ■・「・」、メールは行頭の「- 」と ** を違反にする。
 * 呼ばれた回数を <path>.calls に 1 行ずつ足す。FAKE_LINT_MODE=broken なら読めない出力、exit3 なら終了コード 3、stray なら渡していない id の違反を返す。
 */
export const FAKE_LINT = `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(__filename + '.calls', 'x\\n')
let raw = ''
process.stdin.on('data', (d) => (raw += d)).on('end', () => {
  if (process.env.FAKE_LINT_MODE === 'broken') return process.stdout.write('not json')
  if (process.env.FAKE_LINT_MODE === 'exit3') process.exit(3)
  if (process.env.FAKE_LINT_MODE === 'stray') return (process.stdout.write(JSON.stringify([{ id: 'zz', line: 1, rule: 'x', text: 'x', fix: 'x' }])), process.exit(1))
  let items
  try { items = JSON.parse(raw); if (!Array.isArray(items)) throw 0 } catch { process.stderr.write('入力が壊れている'); process.exit(2) }
  const out = []
  for (const it of items) it.text.split('\\n').forEach((line, i) => {
    if (it.to !== 'mail' && /^\\s*[■・]/.test(line)) out.push({ id: it.id, line: i + 1, rule: 'bullet-symbol', text: line, fix: '箇条書きは「- 」、見出しは太字の 1 行にする' })
    if (it.to === 'mail' && /^\\s*- |\\*\\*/.test(line)) out.push({ id: it.id, line: i + 1, rule: 'markdown-in-mail', text: line, fix: 'メールは記号を使わない' })
  })
  process.stdout.write(JSON.stringify(out))
  process.exit(out.length ? 1 : 0)
})
`
