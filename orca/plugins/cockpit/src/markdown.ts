// 窓からの質問の答え・見張る仕事の出力（Markdown で書かれる）を HTML にする（R167）。依存を足さず、使う書き方だけを描く:
// 見出し・表・太字・箇条書き（番号付きも）・引用・区切り線・コード（行内と囲み）・リンク。
// 本文は先に esc し、生の HTML は文字のまま出す。リンクは http・https だけをボタンにし、ほか（javascript: など）は文字だけを残す。
import type { Repo } from './model.ts'
import { esc, inlineRich } from './view.ts'

const FENCE = /^\s*(```|~~~)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const BULLET = /^\s*[-*+・]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
/** 置き換えの印（私用領域の文字 U+E000〜U+E003）。esc にも等幅の検出にも、inlineRich の URL にも当たらない。 */
const HOLD = /\uE000(\d+)\uE001/g

/**
 * 行内: コードと Markdown のリンクを先に印に置き換え、太字の ** も印にしてから、残りを本文の 1 行と同じ処理にかけ、最後に印を戻す。
 * 太字を HTML にしてから描くと、裸の URL の data-url の中に <strong> が入るので、印のまま inlineRich に通す。
 */
function inline(s: string, repo?: Repo): string {
  const held: string[] = []
  // 印にした元の文字（リンクの宛先に入ったコードの印を、属性に入れる前に元の文字へ戻すため）。
  const raw: string[] = []
  const hold = (html: string, text = '') => (raw.push(text), `\uE000${held.push(html) - 1}\uE001`)
  // 印は入れ子になる（リンクの文の中のコード）。内側の番号のほうが小さいので、戻した結果をもう一度戻す。
  const unhold = (x: string): string => x.replace(HOLD, (_m, i: string) => unhold(held[Number(i)]!))
  // 本文にある印の文字は外す（残すと、別の置き換えに取り違える）。
  const t = s
    .replace(/[\uE000-\uE003]/g, '')
    .replace(/`([^`]+)`/g, (_m, code: string) => hold(`<span class="code">${esc(code)}</span>`, `\`${code}\``))
    .replace(/\[([^\]]+)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\s*\)/g, (_m, label: string, href: string) => {
      const url = href.replace(HOLD, (_x, i: string) => raw[Number(i)]!)
      return hold(/^https?:\/\//i.test(url) ? `<button class="inl" type="button" data-url="${esc(url)}">${esc(label)}</button>` : esc(label))
    })
    .replace(/\*\*(?=\S)(.+?)\*\*/g, '\uE002$1\uE003')
  return unhold(inlineRich(t, repo).replace(/\uE002/g, '<strong>').replace(/\uE003/g, '</strong>'))
}

/** 表の 1 行のセル。端の | を外し、\| は文字の | として残す。 */
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))

export function markdown(text: string | undefined, repo?: Repo): string {
  if (!text) return ''
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; ) {
    const l = lines[i]!
    const fence = FENCE.exec(l)
    if (fence) {
      const body: string[] = []
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) body.push(lines[i]!)
      i++
      out.push(`<pre class="mdpre"><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const h = HEADING.exec(l)
    if (h) {
      // 窓の見出しの段（h2・h3）より下に置く。1 つ目の # を h4 にし、深いものは h6 にまとめる。
      const tag = `h${Math.min(h[1]!.length + 3, 6)}`
      out.push(`<${tag} class="mdh">${inline(h[2]!, repo)}</${tag}>`)
      i++
      continue
    }
    if (RULE.test(l)) {
      out.push('<hr>')
      i++
      continue
    }
    if (l.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      const head = cells(l)
      const rows: string[][] = []
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(cells(lines[i]!))
      out.push(`<div class="mdtbl"><table><thead><tr>${head.map((c) => `<th>${inline(c, repo)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '', repo)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }
    const take = (re: RegExp) => {
      const xs: string[] = []
      for (let m: RegExpExecArray | null; i < lines.length && (m = re.exec(lines[i]!)); i++) xs.push(m[1]!)
      return xs
    }
    if (QUOTE.test(l)) {
      out.push(`<blockquote>${take(QUOTE).filter((x) => x.trim()).map((x) => `<p>${inline(x, repo)}</p>`).join('')}</blockquote>`)
      continue
    }
    if (BULLET.test(l)) {
      out.push(`<ul>${take(BULLET).map((x) => `<li>${inline(x, repo)}</li>`).join('')}</ul>`)
      continue
    }
    if (ORDERED.test(l)) {
      out.push(`<ol>${take(ORDERED).map((x) => `<li>${inline(x, repo)}</li>`).join('')}</ol>`)
      continue
    }
    if (l.trim()) out.push(`<p>${inline(l, repo)}</p>`)
    i++
  }
  return `<div class="rich md">${out.join('')}</div>`
}
