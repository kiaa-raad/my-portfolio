#!/usr/bin/env node
/**
 * Builds og.png — the 1200x630 card Telegram, WhatsApp, LinkedIn, Slack and
 * the rest paste in when someone shares the site's link.
 *
 * It is a separate script rather than part of `npm run build` for the same
 * reason build-cv.mjs is: it needs headless Chrome, and the content build has
 * to stay dependency-free so CI can run it anywhere. Run it when the name,
 * the role or the fields change — which is to say, almost never.
 *
 *   node tools/build-og.mjs          # writes og.png
 *   node tools/build-og.mjs --html   # also keeps the intermediate HTML
 *
 * 1200x630 is the size every one of those scrapers is built around: LinkedIn
 * wants at least 1200x627 before it will show a large card at all, Telegram
 * and WhatsApp centre-crop anything squarer, and 1.91:1 is what Open Graph
 * itself documents. site.config.json points og_image at the result, and the
 * next `npm run build` reads its dimensions back into the meta tags.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

const W = 1200, H = 630;

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The site's own mark, inlined so the render never depends on a file path. */
function mark() {
  const p = join(ROOT, 'favicon.png');
  if (!existsSync(p)) return null;
  return 'data:image/png;base64,' + readFileSync(p).toString('base64');
}

function build() {
  const config = JSON.parse(read(join(ROOT, 'site.config.json')));

  // The fields are whatever is actually in projects/, via the content build,
  // so the card cannot end up advertising a discipline that is no longer there.
  let practice = '';
  const contentPath = join(ROOT, 'content.json');
  if (existsSync(contentPath)) {
    const content = JSON.parse(read(contentPath));
    practice = (content.fields || []).map(f => f.key).join('  /  ');
  }

  const domain = String(config.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  const glyph = mark();

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&family=Azeret+Mono:wght@300;400&display=swap" rel="stylesheet">
<style>
  /* The card is one fixed-size box — no responsive anything, since the only
     viewport it will ever be rendered at is the screenshot's. */
  *{margin:0;padding:0;box-sizing:border-box}

  body{width:${W}px;height:${H}px;overflow:hidden;background:#070708}

  .card{
    position:relative;width:${W}px;height:${H}px;
    background:#070708;color:#f3f3f3;
    font-family:'Archivo',"Segoe UI",-apple-system,Helvetica,Arial,sans-serif;
    display:flex;align-items:center;
    padding:0 84px;
    overflow:hidden;
  }

  /* The field the site draws in WebGL, standing in as flat CSS. */
  .grid{
    position:absolute;inset:0;
    background-image:
      linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),
      linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);
    background-size:60px 60px;
    mask-image:radial-gradient(120% 100% at 30% 50%,#000 30%,transparent 78%);
    -webkit-mask-image:radial-gradient(120% 100% at 30% 50%,#000 30%,transparent 78%);
  }

  .vig{position:absolute;inset:0;
    background:radial-gradient(120% 130% at 50% 50%,transparent 40%,rgba(0,0,0,.85) 100%)}

  /* The corner brackets from the HUD, at the card's scale. */
  .br{position:absolute;width:34px;height:34px;border:2px solid rgba(255,255,255,.26)}
  .br.tl{top:44px;left:44px;border-right:0;border-bottom:0}
  .br.tr{top:44px;right:44px;border-left:0;border-bottom:0}
  .br.bl{bottom:44px;left:44px;border-right:0;border-top:0}
  .br.br2{bottom:44px;right:44px;border-left:0;border-top:0}

  .text{position:relative;z-index:2;flex:1 1 auto;min-width:0}

  .brand{
    font-family:'Azeret Mono',ui-monospace,Consolas,monospace;
    font-weight:400;font-size:15px;letter-spacing:.34em;text-transform:uppercase;
    color:#83878a;margin-bottom:26px;
  }

  h1{font-size:72px;font-weight:700;letter-spacing:-.02em;line-height:1.04;color:#fff}

  .role{
    font-family:'Azeret Mono',ui-monospace,Consolas,monospace;
    font-weight:300;font-size:19px;letter-spacing:.2em;text-transform:uppercase;
    color:#b7babc;margin-top:20px;
  }

  .rule{width:96px;height:2px;background:#f3f3f3;margin:34px 0 26px}

  .fields{
    font-family:'Azeret Mono',ui-monospace,Consolas,monospace;
    font-weight:400;font-size:15px;letter-spacing:.22em;text-transform:uppercase;
    color:#83878a;
  }

  .url{
    position:absolute;left:84px;bottom:70px;z-index:2;
    font-family:'Azeret Mono',ui-monospace,Consolas,monospace;
    font-size:17px;letter-spacing:.2em;text-transform:lowercase;color:#f3f3f3;
  }

  /* The form itself, lit the way the page lights it. */
  .form{position:relative;z-index:2;flex:none;width:330px;height:330px;margin-left:60px}
  .form::before{
    content:"";position:absolute;inset:-70px;
    background:radial-gradient(circle,rgba(255,255,255,.16),transparent 65%);
  }
  .form img{position:relative;width:100%;height:100%;object-fit:contain;display:block}
</style></head>
<body>
  <div class="card">
    <div class="grid"></div>
    <div class="vig"></div>
    <i class="br tl"></i><i class="br tr"></i><i class="br bl"></i><i class="br br2"></i>

    <div class="text">
      ${config.brand ? `<div class="brand">${esc(config.brand)}</div>` : ''}
      <h1>${esc(config.name)}</h1>
      <div class="role">${esc(config.role)}</div>
      <div class="rule"></div>
      ${practice ? `<div class="fields">${esc(practice)}</div>` : ''}
    </div>

    ${glyph ? `<div class="form"><img src="${glyph}" alt=""></div>` : ''}

    ${domain ? `<div class="url">${esc(domain)}</div>` : ''}
  </div>
</body></html>`;
}

/* ── render ───────────────────────────────────────────────────────────── */

function chrome() {
  const found = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter(Boolean).find(p => existsSync(p));
  if (!found) throw new Error('Chrome not found — set CHROME_PATH to a Chrome/Chromium binary.');
  return found;
}

const work = join(tmpdir(), 'og-build');
mkdirSync(work, { recursive: true });

const html = build();
const htmlPath = join(work, 'og.html');
const outPath = join(ROOT, 'og.png');

writeFileSync(htmlPath, html, 'utf8');

execFileSync(chrome(), [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--window-size=${W},${H}`,
  // Long enough for the webfonts to arrive; the card falls back to the system
  // stack rather than rendering blank if they do not.
  '--virtual-time-budget=8000',
  `--screenshot=${outPath}`,
  'file:///' + htmlPath.replace(/\\/g, '/')
], { stdio: 'ignore' });

if (!existsSync(outPath)) throw new Error('Chrome wrote no screenshot.');

if (process.argv.includes('--html')) writeFileSync(join(work, 'og.kept.html'), html, 'utf8');

const kb = Math.round(statSync(outPath).size / 1024);
console.log(`Wrote ${outPath}  ${W}x${H}  ${kb} KB`);

// WhatsApp is the strict one: it gives up on images much past a few hundred
// kilobytes and falls back to a link with no picture at all.
if (kb > 300) console.warn('  over 300 KB — WhatsApp may skip it. Consider a flatter card.');
