/**
 * Builds the srcdoc of a catalog plugin's sandbox frame. Everything the guest
 * needs is INLINED — React + ReactDOM (CJS bundles behind a 3-line require
 * shim), the guest runtime, the plugin source — because the frame's CSP is
 * `default-src 'none'`: it cannot fetch, it cannot import from the app's
 * origin, it cannot load a remote script. The plugin module and the SDK
 * shims become `data:` module URLs INSIDE the frame (guest-runtime.js), so
 * the host never hands the guest a same-origin URL of any kind.
 *
 * The plugin source lands as a JSON string inside a classic `<script>`, so
 * `</script>` inside it is escaped and can never terminate the tag.
 */

import reactDomClientSource from 'react-dom/cjs/react-dom-client.production.js?raw'
import reactDomSource from 'react-dom/cjs/react-dom.production.js?raw'
import jsxDevRuntimeSource from 'react/cjs/react-jsx-dev-runtime.production.js?raw'
import jsxRuntimeSource from 'react/cjs/react-jsx-runtime.production.js?raw'
import reactSource from 'react/cjs/react.production.js?raw'
import schedulerSource from 'scheduler/cjs/scheduler.production.js?raw'

import guestRuntimeSource from './guest-runtime.js?raw'

/** The frame's CSP: nothing loads from anywhere. Inline + data: scripts are
 *  the guest's own code; inline styles are the copied app stylesheet. */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data:; font-src data:"

export interface FrameDocumentInput {
  pluginId: string
  pluginSource: string
  /** Export names of the real `@hermes/plugin-sdk` so every named import links. */
  sdkExports: readonly string[]
  /** App stylesheet text copied into the frame (design tokens + utilities). */
  styleText: string
}

const cjsModule = (name: string, source: string) =>
  `__def(${JSON.stringify(name)}, function (module, exports, require) {\n${source}\n});`

/** A three-line CommonJS shim: `__def` registers a factory, `__req` evaluates
 *  on first use. Bare `require('react')` inside the React bundles resolves
 *  against the registry only — nothing else is requirable. */
const REQUIRE_SHIM = `
var __mods = {}, __cache = {};
function __def(name, factory) { __mods[name] = factory; }
function __req(name) {
  if (__cache[name]) return __cache[name].exports;
  var module = { exports: {} }; __cache[name] = module;
  if (!__mods[name]) throw new Error('sandbox: unknown module ' + name);
  __mods[name](module, module.exports, __req);
  return module.exports;
}
`

const escapeScriptClose = (json: string) => json.replace(/<\//g, '<\\/')

export function buildFrameDocument(input: FrameDocumentInput): string {
  const boot = escapeScriptClose(
    JSON.stringify({ pluginId: input.pluginId, pluginSource: input.pluginSource, sdkExports: input.sdkExports })
  )

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">
<style>
html, body { margin: 0; background: transparent; overflow: hidden; }
body { pointer-events: none; }
.hermes-sandbox-slot { position: fixed; overflow: hidden; pointer-events: auto; }
.hermes-sandbox-slot-inner { display: inline-flex; height: 100%; max-width: 100%; }
[data-slot^="panes:"] .hermes-sandbox-slot-inner, [data-slot^="workspace:"] .hermes-sandbox-slot-inner { display: block; width: 100%; }
.hermes-sandbox-error { font-size: 0.6875rem; color: #c0392b; }
</style>
<style>${input.styleText.replace(/<\//g, '<\\/')}</style>
</head>
<body>
<div id="slots"></div>
<script>
process = { env: { NODE_ENV: 'production' } };
${REQUIRE_SHIM}
${cjsModule('react', reactSource)}
${cjsModule('react/jsx-runtime', jsxRuntimeSource)}
${cjsModule('react/jsx-dev-runtime', jsxDevRuntimeSource)}
${cjsModule('scheduler', schedulerSource)}
${cjsModule('react-dom', reactDomSource)}
${cjsModule('react-dom/client', reactDomClientSource)}
globalThis.__HERMES_REACT__ = __req('react');
globalThis.__HERMES_REACT_JSX__ = __req('react/jsx-runtime');
globalThis.__HERMES_REACT_JSX_DEV__ = __req('react/jsx-dev-runtime');
globalThis.__HERMES_REACT_DOM_CLIENT__ = __req('react-dom/client');
globalThis.__HERMES_SANDBOX__ = ${boot};
</script>
<script>${guestRuntimeSource}</script>
</body>
</html>`
}

/** The app's own stylesheet rules, as text, so plugin UI inside the frame
 *  gets the same tokens and utility classes. Style is not authority; a
 *  stylesheet the host can't read (cross-origin) is skipped. */
export function collectHostStyleText(doc: Document = document): string {
  const chunks: string[] = []

  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      chunks.push(Array.from(sheet.cssRules, rule => rule.cssText).join('\n'))
    } catch {
      // Cross-origin or detached sheet — nothing a plugin needs.
    }
  }

  return chunks.join('\n')
}
