import assert from 'node:assert/strict'
import { test } from 'node:test'
import { morph } from './morph.ts'

// morph が使う分だけの DOM。書き換えの回数を数える。
let writes = 0
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
