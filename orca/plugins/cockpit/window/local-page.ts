// 手元の HTML のページ（Gemini の窓口・担当が深田さんに見せるもの）を Chrome で開く。置き場所は ~/orca-pages/<ワークスペース名>/<ファイル名>.html。
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PAGES_DIR = path.join(os.homedir(), 'orca-pages')

/** ページを Chrome で開く。引数は配列で渡し、シェルを通さない。 */
export const openInChrome = (file: string) =>
  new Promise<void>((resolve, reject) => execFile('/usr/bin/open', ['-a', 'Google Chrome', file], { timeout: 15_000 }, (err) => (err ? reject(err) : resolve())))

/**
 * カードの成果物の href が ~/orca-pages の下を指していれば、開いてよいページの実体のパスか断る理由を返す。指していなければ undefined
 * （ワークスペースの中のファイルとして今までどおり開く）。開けるのは ~/orca-pages の下の .html だけで、
 * 窓のサーバーが任意のファイルを開く口にならないよう、.. と、シンボリックリンクで外を指すものは断る。
 */
export async function localPage(href: string, dir = PAGES_DIR): Promise<{ file: string } | { reason: string } | undefined> {
  const raw = href.startsWith('file://') ? fileURLToPath(href) : href.startsWith('~/') ? path.join(os.homedir(), href.slice(2)) : href
  if (!raw.startsWith(dir + path.sep)) return undefined
  if (raw.split(path.sep).includes('..')) return { reason: `.. を含むパスは開かない: ${href}` }
  if (path.extname(raw).toLowerCase() !== '.html') return { reason: `~/orca-pages の下で開くのは .html だけ: ${href}` }
  // 置き場所そのものがリンクだと、リンク先が許可範囲の基準になり外の HTML が通るため断る。検査のあとの差し替え（TOCTOU）には備えない:
  // 同じ利用者だけが書けるディレクトリで、単一利用者の Mac のため。
  if ((await fsp.lstat(dir).catch(() => undefined))?.isSymbolicLink()) return { reason: `~/orca-pages そのものがシンボリックリンクなので開かない: ${href}` }
  const [real, base] = await Promise.all([fsp.realpath(raw).catch(() => ''), fsp.realpath(dir).catch(() => '')])
  if (!real) return { reason: `ファイルが見つかりません: ${href}` }
  if (!base || !real.startsWith(base + path.sep) || path.extname(real).toLowerCase() !== '.html') return { reason: `~/orca-pages の外を指すファイルは開かない: ${href}` }
  if (!(await fsp.stat(real)).isFile()) return { reason: `ファイルではありません: ${href}` }
  return { file: real }
}
