/**
 * 描き直した HTML（to）と今の DOM（from）の違う部分だけを from に当てる。
 * innerHTML で作り直すと、欄のスクロール位置・入力欄のフォーカスとカーソル・変換中の文字が失われるため。
 * 子は要素名・id・class・data 属性が同じものを対応させる（上に知らせの行が 1 つ増えても、下の欄を作り直さない）。
 * フォーカスのある要素とその祖先は、作り直しも移動もしない（insertBefore で動かすだけでもフォーカスが外れるため）。
 * 前の兄弟が消えたときは祖先を前へ動かさず、消えた兄弟のほうを後ろへ回す。祖先の class・data 属性が変わったときは、
 * 別の要素と見なして差し替えず、同じ要素の属性を書き換える。フォーカスのある入力欄は、中身にも値にも触らない。
 */
export function morph(from: Node, to: Node, active: Element | null): void {
  walk(from, to, active, pinOf(from, to, active))
}

/** to の中でフォーカスのある要素にあたる要素から上の各段を、from の同じ段の祖先に結ぶ。段の数か要素名が食い違えば結ばない。 */
type Pin = { to: Map<Node, Node>; from: Set<Node> }

function pinOf(from: Node, to: Node, active: Element | null): Pin | undefined {
  if (!active) return undefined
  const twin = find(to, key(active))
  const a = twin && chain(active, from)
  const b = twin && chain(twin, to)
  if (!a || !b || a.length !== b.length || a.some((n, i) => n.nodeName !== b[i]!.nodeName)) return undefined
  return { to: new Map(b.map((n, i) => [n, a[i]!])), from: new Set(a) }
}

function walk(from: Node, to: Node, active: Element | null, pin: Pin | undefined): void {
  let at = 0
  const keep = pin && Array.from(from.childNodes).find((n) => pin.from.has(n))
  for (const y of Array.from(to.childNodes)) {
    const held = pin?.to.get(y)
    const rest = Array.from(from.childNodes).slice(at)
    const x = held && rest.includes(held) ? held : rest.find((n) => n !== keep && key(n) === key(y))
    if (!x) {
      from.insertBefore(y, from.childNodes[at] ?? null)
    } else {
      if (x === keep) {
        const after = x.nextSibling
        while (from.childNodes[at] !== x) from.insertBefore(from.childNodes[at]!, after)
      } else if (x !== from.childNodes[at]) from.insertBefore(x, from.childNodes[at]!)
      patch(x, y, active, pin)
    }
    at++
  }
  while (from.childNodes.length > at) from.removeChild(from.lastChild!)
}

function patch(x: Node, y: Node, active: Element | null, pin: Pin | undefined): void {
  if (x.nodeType !== 1) {
    if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue
    return
  }
  const a = x as Element
  const b = y as Element
  if (a === active && isField(a)) return
  for (const { name } of Array.from(a.attributes)) if (!b.hasAttribute(name)) a.removeAttribute(name)
  for (const { name, value } of Array.from(b.attributes)) if (a.getAttribute(name) !== value) a.setAttribute(name, value)
  // 値は子を移す前に読む（walk は空の欄に入れる文字の節を b から a へ移すので、あとで読むと b の値が空になる）。
  const want = isField(b) ? (b as HTMLTextAreaElement).value : undefined
  walk(a, b, active, pin)
  // 中身の文字（初期値）を変えても、打ち込まれたあとの value は変わらない。送ったあとに欄を空にするには value を合わせる。
  if (want !== undefined && (a as HTMLTextAreaElement).value !== want) (a as HTMLTextAreaElement).value = want
}

const isField = (e: Element) => e.nodeName === 'TEXTAREA' || e.nodeName === 'INPUT'

/** n から root の子までの祖先（n を含む）。root の中に無ければ undefined。 */
function chain(n: Node, root: Node): Node[] | undefined {
  const out: Node[] = []
  for (let p: Node | null = n; p; p = p.parentNode) {
    if (p === root) return out
    out.push(p)
  }
  return undefined
}

function find(n: Node, k: string): Node | undefined {
  for (const c of Array.from(n.childNodes)) {
    if (c.nodeType !== 1) continue
    if (key(c) === k) return c
    const hit = find(c, k)
    if (hit) return hit
  }
  return undefined
}

function key(n: Node): string {
  if (n.nodeType !== 1) return `#${n.nodeType}`
  const e = n as Element
  const data = Array.from(e.attributes).filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value}`)
  return [e.nodeName, e.getAttribute('id') ?? '', e.getAttribute('class') ?? '', ...data].join('|')
}
