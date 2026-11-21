/**
 * 描き直した HTML（to）と今の DOM（from）の違う部分だけを from に当てる。
 * innerHTML で作り直すと、欄のスクロール位置・入力欄のフォーカスとカーソル・変換中の文字が失われるため。
 * 子は要素名・id・class・data 属性が同じものを対応させる（上に知らせの行が 1 つ増えても、下の欄を作り直さない）。
 * フォーカスのある入力欄は、中身にも値にも触らない。
 */
export function morph(from: Node, to: Node, active: Element | null): void {
  let at = 0
  for (const y of Array.from(to.childNodes)) {
    const k = key(y)
    const rest = Array.from(from.childNodes).slice(at)
    const x = rest.find((n) => key(n) === k)
    if (!x) {
      from.insertBefore(y, from.childNodes[at] ?? null)
    } else {
      if (x !== from.childNodes[at]) from.insertBefore(x, from.childNodes[at])
      patch(x, y, active)
    }
    at++
  }
  while (from.childNodes.length > at) from.removeChild(from.lastChild!)
}

function patch(x: Node, y: Node, active: Element | null): void {
  if (x.nodeType !== 1) {
    if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue
    return
  }
  const a = x as Element
  const b = y as Element
  if (a === active && isField(a)) return
  for (const { name } of Array.from(a.attributes)) if (!b.hasAttribute(name)) a.removeAttribute(name)
  for (const { name, value } of Array.from(b.attributes)) if (a.getAttribute(name) !== value) a.setAttribute(name, value)
  morph(a, b, active)
  // 中身の文字（初期値）を変えても、打ち込まれたあとの value は変わらない。送ったあとに欄を空にするには value を合わせる。
  if (isField(a) && (a as HTMLTextAreaElement).value !== (b as HTMLTextAreaElement).value) (a as HTMLTextAreaElement).value = (b as HTMLTextAreaElement).value
}

const isField = (e: Element) => e.nodeName === 'TEXTAREA' || e.nodeName === 'INPUT'

function key(n: Node): string {
  if (n.nodeType !== 1) return `#${n.nodeType}`
  const e = n as Element
  const data = Array.from(e.attributes).filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value}`)
  return [e.nodeName, e.getAttribute('id') ?? '', e.getAttribute('class') ?? '', ...data].join('|')
}
