import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdown } from './markdown.ts'

test('答えの Markdown（R167）: 見出し・表・太字・箇条書き・番号付き・引用・区切り線・コードを描く', () => {
  const h = markdown([
    '## 結論', '入口は **1 つ** にする。', '', '### 比べた案', '| 案 | 手間 |', '|---|:--:|', '| A | 小さい |', '| B \\| C | 大きい |', '',
    '- 一覧を直す', '- 帳簿を直す', '1. 先に調べる', '2. 次に作る', '> 森さんの発言', '---', '`cockpit-write` で書く', '```', 'const x = 1 < 2', '```'
  ].join('\n'))
  assert.match(h, /<h5 class="mdh">結論<\/h5>/)
  assert.match(h, /<h6 class="mdh">比べた案<\/h6>/)
  assert.match(h, /<p>入口は <strong>1 つ<\/strong> にする。<\/p>/)
  assert.match(h, /<div class="mdtbl"><table><thead><tr><th>案<\/th><th>手間<\/th><\/tr><\/thead><tbody><tr><td>A<\/td><td>小さい<\/td><\/tr><tr><td>B \| C<\/td><td>大きい<\/td><\/tr><\/tbody><\/table><\/div>/)
  assert.match(h, /<ul><li>一覧を直す<\/li><li>帳簿を直す<\/li><\/ul><ol><li>先に調べる<\/li><li>次に作る<\/li><\/ol>/)
  assert.match(h, /<blockquote><p>森さんの発言<\/p><\/blockquote><hr>/)
  assert.match(h, /<span class="code">cockpit-write<\/span> で書く/)
  assert.match(h, /<pre class="mdpre"><code>const x = 1 &#60; 2<\/code><\/pre>/)
  assert.doesNotMatch(h, /##|\*\*|\|---/)
})

test('答えの Markdown（R167）: 生の HTML は文字のまま、リンクは http・https だけをボタンにする', () => {
  const h = markdown('<script>alert(1)</script> と <b>太字</b>\n[資料](https://example.com/a?x=1&y=2) と [悪い](javascript:alert(1)) と [ファイル](file:///etc/passwd)\n## <img src=x onerror=alert(1)>')
  assert.doesNotMatch(h, /<script|<b>|<img/)
  assert.match(h, /&#60;script&#62;alert\(1\)&#60;\/script&#62;/)
  assert.match(h, /<button class="inl" type="button" data-url="https:\/\/example.com\/a\?x=1&#38;y=2">資料<\/button>/)
  assert.doesNotMatch(h, /javascript:|file:/)
  assert.match(h, / と 悪い と ファイル/)
  // 表のセルとコードの中でも同じ（コードの中の ** や [x](y) は描かない）。
  const t = markdown('| a | b |\n|---|---|\n| <i>x</i> | `**y** [z](https://e.com)` |')
  assert.match(t, /<td>&#60;i&#62;x&#60;\/i&#62;<\/td><td><span class="code">\*\*y\*\* \[z\]\(https:\/\/e.com\)<\/span><\/td>/)
})

test('答えの Markdown: 印の文字（私用領域）を本文に書かれても、置き換えを取り違えない', () => {
  assert.equal(markdown('\uE0000\uE001 と `x`'), '<div class="rich md"><p>0 と <span class="code">x</span></p></div>')
})

test('答えの Markdown: 裸の URL とリンク・コード・太字が隣り合っても、属性の中にタグを入れない（Codex 36 重大）', () => {
  const tags = (h: string) => [...h.matchAll(/data-url="([^"]*)"/g)].map((m) => m[1]!)
  // 裸の URL の直後にリンクを書いても、印を URL に取り込まない。
  const a = markdown('https://example.test/[資料](https://example.org)')
  assert.ok(tags(a).every((u) => !/[<>-]/.test(u)), a)
  assert.match(a, /data-url="https:\/\/example.org">資料<\/button>/)
  // 太字の中の URL も、data-url に <strong> を入れない。
  const b = markdown('**https://example.test/x** と https://example.test/**y z**')
  assert.ok(tags(b).every((u) => !/[<>]/.test(u)), b)
  assert.match(b, /<strong><button class="inl" type="button" data-url="https:\/\/example.test\/x">リンク<\/button><\/strong>/)
  // リンクの宛先にコードの書き方が入っても、属性にはタグではなく元の文字を入れる（Codex 36 2 巡目 3）。
  const c = markdown('[資料](https://example.org/`id`)')
  assert.match(c, /data-url="https:\/\/example.org\/`id`">資料<\/button>/)
  // リンクの文の中のコードも描く（印の番号を残さない）。
  assert.equal(markdown('[`npm test`](https://example.org)'), '<div class="rich md"><p><button class="inl" type="button" data-url="https://example.org"><span class="code">npm test</span></button></p></div>')
})
