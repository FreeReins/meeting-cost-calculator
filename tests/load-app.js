// Loads the app's code straight out of index.html (the single source of truth),
// so the tests always exercise exactly what the browser runs.
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const blocks = [...html.matchAll(/<script data-src="([^"]+)">\n([\s\S]*?)\n<\/script>/g)];
if (blocks.length < 10) throw new Error(`Expected the app's <script data-src> blocks in index.html, found ${blocks.length}`);

// Everything except main.js, which wires up the DOM on load.
for (const [, src, code] of blocks) {
  if (src !== 'js/main.js') runInThisContext(code, { filename: `index.html#${src}` });
}

export const MM = /** @type {any} */ (globalThis).MM;
