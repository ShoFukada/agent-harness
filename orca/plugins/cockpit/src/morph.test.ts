import assert from 'node:assert/strict'
import { test } from 'node:test'
import { morph } from './morph.ts'

// morph が使う分だけの DOM。書き換えの回数と、DOM の中で動かした要素を数える（ブラウザは動かした要素の中のフォーカスを外す）。
let writes = 0
let moved: N[] = []
class N {
  childNodes: N[] = []
  parent?: N
  nodeType: number
  nodeName: string
  text: string
  constructor(nodeType: number, nodeName: string, text = '') {
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.text = text
  }
  get parentNode(): N | null {
    return this.parent ?? null
  }
  get nextSibling(): N | null {
    const xs = this.parent?.childNodes
    return xs?.[xs.indexOf(this) + 1] ?? null
  }
  get nodeValue() {
    return this.nodeType === 1 ? null : this.text
  }
  set nodeValue(v) {
    writes++
    this.text = v ?? ''
  }
  appendChild(c: N) {
    writes++
    c.parent?.childNodes.splice(c.parent.childNodes.indexOf(c), 1)
    c.parent = this
    this.childNodes.push(c)
  }
  insertBefore(c: N, ref: N | null) {
    writes++
    if (c.parent) moved.push(c)
    c.parent?.childNodes.splice(c.parent.childNodes.indexOf(c), 1)
    c.parent = this
    if (ref) this.childNodes.splice(this.childNodes.indexOf(ref), 0, c)
    else this.childNodes.push(c)
  }
  get lastChild(): N | null {
    return this.childNodes.at(-1) ?? null
  }
  removeChild(c: N) {
    writes++
    this.childNodes.splice(this.childNodes.indexOf(c), 1)
    c.parent = undefined
  }
}
class E extends N {
  attrs = new Map<string, string>()
  value = ''
  constructor(tag: string, attrs: Record<string, string> = {}, kids: N[] = []) {
    super(1, tag.toUpperCase())
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v)
    for (const k of kids) {
      k.parent = this
      this.childNodes.push(k)
    }
    if (tag === 'textarea') this.value = kids.map((k) => k.nodeValue).join('')
  }
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }))
  }
  getAttribute(n: string) {
    return this.attrs.get(n) ?? null
  }
  hasAttribute(n: string) {
    return this.attrs.has(n)
  }
  setAttribute(n: string, v: string) {
    writes++
    this.attrs.set(n, v)
  }
  removeAttribute(n: string) {
    writes++
    this.attrs.delete(n)
  }
}
const t = (s: string) => new N(3, '#text', s)
const run = (from: E, to: E, active: E | null = null) => {
  writes = 0
  moved = []
  morph(from as unknown as Node, to as unknown as Node, active as unknown as Element)
  return writes
}
const page = (title: string, draft: string, box = 'd1') =>
  new E('div', { class: 'ck' }, [
    new E('div', { class: 'list' }, [new E('button', { 'data-cur': 'd1', 'aria-current': 'true' }, [t(title)])]),
    new E('div', { class: 'detail' }, [new E('h2', {}, [t(title)]), new E('textarea', { 'data-chatbox': box }, [t(draft)])])
  ])

test('同じ中身なら DOM を 1 か所も書き換えない', () => {
  const now = page('担当者の割り当て方を決める', '')
  assert.equal(run(now, page('担当者の割り当て方を決める', '')), 0)
})

test('違う部分だけを書き換え、スクロールする欄の要素は使い回す', () => {
  const now = page('担当者の割り当て方を決める', '')
  const [list, detail] = now.childNodes
  assert.equal(run(now, page('担当者の割り当て方を決め直す', '')), 2)
  assert.equal(now.childNodes[0], list)
  assert.equal(now.childNodes[1], detail)
  assert.equal((detail.childNodes[0].childNodes[0] as N).nodeValue, '担当者の割り当て方を決め直す')
})

test('上に知らせの行が増えても、下の欄の要素は使い回す', () => {
  const now = page('題', '')
  const [list, detail] = now.childNodes
  const next = page('題', '')
  next.childNodes.unshift(new E('div', { class: 'notes' }, [t('未反映の操作 1 件')]))
  run(now, next)
  assert.equal(now.childNodes.length, 3)
  assert.equal(now.childNodes[1], list)
  assert.equal(now.childNodes[2], detail)
})

test('入力中の欄は、描き直しても要素も書きかけも替えない', () => {
  const now = page('題', 'B にした場合')
  const box = now.childNodes[1].childNodes[1] as E
  box.value = 'B にした場合、既存の 18 社は'
  run(now, page('題（更新）', 'B にした場合、既存'), box)
  assert.equal(now.childNodes[1].childNodes[1], box)
  assert.equal(box.value, 'B にした場合、既存の 18 社は')
})

test('入力していない欄は、送ったあとの空の書きかけに合わせる', () => {
  const now = page('題', '送った文')
  const box = now.childNodes[1].childNodes[1] as E
  box.value = '送った文'
  run(now, page('題', ''))
  assert.equal(box.value, '')
})

test('入力中でも別の項目の欄に変わったら作り直す', () => {
  const now = page('題', 'd1 の書きかけ')
  const box = now.childNodes[1].childNodes[1] as E
  run(now, page('別の題', '', 'd3'), box)
  assert.notEqual(now.childNodes[1].childNodes[1], box)
  assert.equal((now.childNodes[1].childNodes[1] as E).getAttribute('data-chatbox'), 'd3')
})

// 窓の右の欄の形（帯の行 → 本体 → 詳細 → 欄が並ぶ → 入力欄）。
const win = (o: { note?: boolean; cls?: string; asked?: boolean; draft?: string } = {}) =>
  new E('div', { class: 'wcol' }, [
    ...(o.note ? [new E('div', { class: 'wnotes' }, [t('帳簿の形式不備 1 件')])] : []),
    new E('main', { class: 'wbody' }, [
      new E('aside', { class: 'wside' }, [
        new E('div', { class: o.cls ?? 'wdet k-review' }, [
          ...(o.asked === false ? [] : [new E('div', { class: 'fld' }, [t('聞かれていること')])]),
          new E('div', { class: 'fld' }, [new E('textarea', { id: 'ans-r5', 'data-ansdraft': 'r5' }, [t(o.draft ?? '')])]),
          new E('div', { class: 'fld' }, [t('直前の発言')])
        ])
      ])
    ])
  ])
const boxOf = (w: E) => w.childNodes.at(-1)!.childNodes[0]!.childNodes[0]!.childNodes.find((f) => f.childNodes[0] instanceof E)!.childNodes[0] as E
const html = (n: N): string => (n instanceof E ? `<${n.nodeName}${n.attributes.map((a) => ` ${a.name}="${a.value}"`).join('')}>${n.childNodes.map(html).join('')}</${n.nodeName}>` : n.text)
const chainOf = (n: N) => {
  const out: N[] = []
  for (let p: N | undefined = n; p; p = p.parent) out.push(p)
  return out
}

test('上の帯の行が消えても、入力中の欄とその祖先を動かさない', () => {
  const now = win({ note: true })
  const box = boxOf(now)
  box.value = '並べ替えの既定を'
  run(now, win(), box)
  assert.equal(html(now), html(win()))
  assert.equal(boxOf(now), box)
  assert.deepEqual(moved.filter((m) => chainOf(box).includes(m)), [])
  assert.equal(now.childNodes.length, 1)
  assert.equal(box.value, '並べ替えの既定を')
})

test('祖先の class が変わっても、入力中の欄は同じ要素のまま残り、祖先の属性を書き換える', () => {
  const now = win()
  const box = boxOf(now)
  box.value = 'キャッシュで'
  const det = box.parent!.parent!
  run(now, win({ cls: 'wdet k-stuck' }), box)
  assert.equal(html(now), html(win({ cls: 'wdet k-stuck' })))
  assert.equal(boxOf(now), box)
  assert.equal(box.parent!.parent, det)
  assert.equal((det as E).getAttribute('class'), 'wdet k-stuck')
  assert.equal(box.value, 'キャッシュで')
  assert.deepEqual(moved.filter((m) => chainOf(box).includes(m)), [])
})

test('同じ形の欄が並ぶ中で前の欄が消えても、入力中の欄を作り直さない', () => {
  const now = win()
  const box = boxOf(now)
  box.value = '2 にする'
  run(now, win({ asked: false }), box)
  assert.equal(html(now), html(win({ asked: false })))
  assert.equal(boxOf(now), box)
  assert.deepEqual(moved.filter((m) => chainOf(box).includes(m)), [])
  const fields = box.parent!.parent!.childNodes
  assert.equal(fields.length, 2)
  assert.equal(fields[0], box.parent)
  assert.equal((fields[1]!.childNodes[0] as N).nodeValue, '直前の発言')
})

test('入力していなければ、前の兄弟が消えたときはこれまでどおり後ろの要素を前へ詰める', () => {
  const now = win({ note: true })
  const main = now.childNodes[1]
  run(now, win())
  assert.equal(now.childNodes.length, 1)
  assert.equal(now.childNodes[0], main)
})
