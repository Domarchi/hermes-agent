// `desktop_capabilities:` from a unified package's plugin.yaml — the grant list
// the renderer's sandbox loader consults for catalog-tier desktop halves.
//
// Deliberately a line parser, not a YAML library: the manifest is read from
// the Electron main process during the desktop-half reconcile, the field is a
// flat list of tokens, and the renderer drops unknown names anyway. Two forms:
//
//   desktop_capabilities: [ui, storage, os:clipboard]
//   desktop_capabilities:
//     - ui
//     - gateway:request   # comment
import fs from 'node:fs'
import path from 'node:path'

const KEY_RE = /^desktop_capabilities\s*:\s*(.*)$/
const ITEM_RE = /^\s+-\s*(.+?)\s*$/

const stripComment = (line: string) => line.replace(/\s+#.*$/, '').trim()
const unquote = (token: string) => token.trim().replace(/^['"]|['"]$/g, '')

/** Returns the declared list, or undefined when the manifest has no
 *  `desktop_capabilities:` key (the loader then applies its defaults). */
export function parseDesktopCapabilities(yamlText: string): string[] | undefined {
  const lines = yamlText.split(/\r?\n/)
  const start = lines.findIndex(line => KEY_RE.test(line))

  if (start === -1) {
    return undefined
  }

  const inline = stripComment(KEY_RE.exec(lines[start])![1] ?? '')

  if (inline.startsWith('[')) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(unquote)
      .filter(Boolean)
  }

  const items: string[] = []

  for (const line of lines.slice(start + 1)) {
    const match = ITEM_RE.exec(stripComment(line) ? line : '')

    if (!match) {
      if (stripComment(line)) {
        break // Next key — the list ended.
      }

      continue // Blank/comment line inside the list.
    }

    items.push(unquote(stripComment(match[1])))
  }

  return items.filter(Boolean)
}

/** Read `plugin.yaml`/`plugin.yml` beside a package and parse its grant list. */
export async function readDesktopCapabilities(packageDir: string): Promise<string[] | undefined> {
  for (const name of ['plugin.yaml', 'plugin.yml']) {
    try {
      return parseDesktopCapabilities(await fs.promises.readFile(path.join(packageDir, name), 'utf8'))
    } catch {
      // Try the other spelling; a missing manifest means no declaration.
    }
  }

  return undefined
}
