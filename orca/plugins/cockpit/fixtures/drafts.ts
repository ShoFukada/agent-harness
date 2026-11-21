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
