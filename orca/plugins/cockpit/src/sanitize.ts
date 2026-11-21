/** figure の SVG から、スクリプト・外部参照・イベント属性を取り除く。パネルと窓のページが使う。 */
export function sanitize(raw: string): string {
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml')
  const root = doc.documentElement
  if (root.nodeName !== 'svg' || doc.querySelector('parsererror')) return ''
  // set・animate は属性を後から書き換えられるので、href に javascript: を戻されないよう要素ごと落とす。
  root.querySelectorAll('script,foreignObject,iframe,object,embed,style,a,set,animate,animateMotion,animateTransform,discard')
    .forEach((n) => n.remove())
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase()
      const val = a.value.trim().toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(a.name)
      else if ((name === 'href' || name === 'xlink:href') && !val.startsWith('#')) el.removeAttribute(a.name)
      else if (/url\(\s*['"]?(?!#)/.test(val)) el.removeAttribute(a.name)
    }
  }
  return root.outerHTML
}
