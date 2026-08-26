#!/usr/bin/env node
/**
 * Builds about/cv.pdf from about/resume.md.
 *
 * The resume markdown stays the single source of truth: edit it, re-run this,
 * and the PDF follows. Rendering goes through headless Chrome, which is what
 * produced the original file, so type rasterises and subsets identically.
 *
 *   node tools/build-cv.mjs            # writes about/cv.pdf
 *   node tools/build-cv.mjs --html     # also keeps the intermediate HTML
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

/* Scratch space for the intermediate pages handed to Chrome. */
const work = join(tmpdir(), 'cv-build');
mkdirSync(work, { recursive: true });

/* ── markdown ─────────────────────────────────────────────────────────── */

/** Splits "## Heading" blocks into { heading: body }, lowercased keys. */
function sections(md) {
  const out = {};
  let key = '_intro', buf = [];
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { out[key] = buf.join('\n').trim(); key = h[1].toLowerCase(); buf = []; }
    else buf.push(line);
  }
  out[key] = buf.join('\n').trim();
  return out;
}

/** A block is an "a | b | c | d" meta line plus the "- " bullets under it. */
function entries(body) {
  const out = [];
  for (const line of (body || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('- ')) { if (out.length) out[out.length - 1].bullets.push(t.slice(2).trim()); continue; }
    out.push({ meta: t.split('|').map(s => s.trim()).map(s => (s === '-' ? '' : s)), bullets: [] });
  }
  return out;
}

/** "Disciplines: a, b, c" lines under the ## Skills heading of resume.md. */
function skills(body) {
  const out = [];
  for (const line of (body || '').split(/\r?\n/)) {
    const m = /^([^:]{1,30}):\s*(.+)$/.exec(line.trim());
    if (m) out.push({ label: m[1].trim().toUpperCase(), items: m[2].split(',').map(s => s.trim()).filter(Boolean) });
  }
  return out;
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Strips protocol and trailing slash so a URL reads as a label, not an address. */
const pretty = u => String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

/* ── icons ────────────────────────────────────────────────────────────── */

const ICON = {
  email: '<path d="M2.6 5.6h18.8v12.8H2.6z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M2.6 6.3 12 13.2l9.4-6.9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  phone: '<path d="M6.2 2.9h3.1l1.6 4.1-2.1 1.6a12.4 12.4 0 0 0 6.6 6.6l1.6-2.1 4.1 1.6v3.1a2.1 2.1 0 0 1-2.3 2.1A18.6 18.6 0 0 1 4.1 5.2a2.1 2.1 0 0 1 2.1-2.3z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
  portfolio: '<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.9"/><ellipse cx="12" cy="12" rx="3.9" ry="9.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M3.4 9h17.2M3.4 15h17.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  linkedin: '<path d="M4.6 8.9h3.3V21H4.6zM6.25 3a2.05 2.05 0 1 1 0 4.1 2.05 2.05 0 0 1 0-4.1zM10.4 8.9h3.16v1.65h.05c.44-.83 1.52-1.71 3.13-1.71 3.35 0 3.97 2.2 3.97 5.07V21h-3.3v-5.32c0-1.27-.02-2.9-1.77-2.9-1.77 0-2.04 1.38-2.04 2.81V21h-3.3z" fill="currentColor"/>'
};

const icon = k => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;

/* ── logos ────────────────────────────────────────────────────────────── */

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** Square edge the logos are normalised to — ~4x their 37px slot, print-safe. */
const LOGO_PX = 160;

/** filename → normalised data URI, filled in by prepareLogos() before build(). */
let MARKS = {};

const source = file => {
  const p = join(ROOT, 'about', 'logos', file);
  if (!existsSync(p)) { console.warn('  logo missing, skipped: ' + file); return null; }
  const type = MIME[(file.match(/\.[^.]+$/) || [''])[0].toLowerCase()];
  if (!type) { console.warn('  unsupported logo type, skipped: ' + file); return null; }
  return `data:${type};base64,${readFileSync(p).toString('base64')}`;
};

/**
 * Chrome embeds images at their source resolution, so a 1200px logo destined
 * for a 37px circle would ride along in full. This centre-crops each one to a
 * LOGO_PX square on white and re-encodes it as JPEG, using the same headless
 * Chrome the PDF already depends on rather than an image library. Falls back
 * to the untouched originals if the pass fails — a fat PDF beats no PDF.
 */
function prepareLogos(names) {
  const originals = {};
  for (const n of names) { const d = source(n); if (d) originals[n] = d; }
  if (!Object.keys(originals).length) return {};

  const page = `<meta charset="utf-8"><body><script>
    const SRC = ${JSON.stringify(originals)}, N = ${LOGO_PX}, out = {};
    Promise.all(Object.entries(SRC).map(([name, src]) => new Promise(done => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = N;
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, N, N);
        // Cover: the circle crops to a square anyway, so fill it edge to edge.
        const s = Math.max(N / img.width, N / img.height);
        const w = img.width * s, h = img.height * s;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, (N - w) / 2, (N - h) / 2, w, h);
        out[name] = c.toDataURL('image/jpeg', 0.88);
        done();
      };
      img.onerror = () => done();
      img.src = src;
    }))).then(() => {
      document.title = 'ready';
      const el = document.createElement('pre');
      el.id = 'out';
      el.textContent = JSON.stringify(out);
      document.body.appendChild(el);
    });
  <\/script>`;

  const p = join(work, 'logos.html');
  writeFileSync(p, page, 'utf8');

  try {
    const dom = execFileSync(chrome(), [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=15000', '--dump-dom',
      'file:///' + p.replace(/\\/g, '/')
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

    const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
    if (!m) throw new Error('no canvas output');
    const scaled = JSON.parse(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));

    // Keep whichever encoding is actually smaller for each individual mark.
    const out = {};
    for (const [name, orig] of Object.entries(originals)) {
      out[name] = (scaled[name] && scaled[name].length < orig.length) ? scaled[name] : orig;
    }
    return out;
  } catch (err) {
    console.warn('  logo downscaling skipped (' + err.message + ') — embedding originals.');
    return originals;
  }
}

const logo = file => (file ? MARKS[file] || null : null);

/* ── template ─────────────────────────────────────────────────────────── */

const section = (label, inner) => `<section class="sec"><h2>${label}</h2>${inner}</section>`;

/**
 * One experience/education entry: the organisation's logo in a circle on the
 * left, then the role, its dates, the organisation and the bullets. The logo
 * carries the outbound link — the role title is plain text, so the only thing
 * that invites a click is the mark itself.
 */
function block({ meta, bullets }) {
  const [title, org, dates, link, mark] = meta;
  const src = logo(mark);

  // Without a mark there is nothing to click, so the title takes the link back.
  const badge = src
    ? `<${link ? 'a' : 'span'} class="mark"${link ? ` href="${esc(link)}"` : ''}><img src="${src}" alt=""></${link ? 'a' : 'span'}>`
    : '';
  const heading = (!src && link) ? `<a href="${esc(link)}">${esc(title)}</a>` : esc(title);

  return `<article class="item">${badge}<div class="body">`
    + `<div class="row"><span class="ttl">${heading}</span><span class="when">${esc(dates)}</span></div>`
    + (org ? `<div class="org">${esc(org)}</div>` : '')
    + (bullets.length ? `<ul>${bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : '')
    + '</div></article>';
}

/** Certifications and volunteering share one two-column rule-separated rhythm. */
const lines = list => list.map(({ meta }) => {
  const left = meta[3] ? `<a href="${esc(meta[3])}">${esc(meta[0])}</a>` : esc(meta[0]);
  const right = [meta[1], meta[2]].filter(Boolean).join(' · ');
  return `<div class="line"><span class="line-a">${left}</span><span class="line-b">${esc(right)}</span></div>`;
}).join('');

function build() {
  const resume = sections(read(join(ROOT, 'about', 'resume.md')));
  const experience = entries(resume.experience);
  const education = entries(resume.education);

  // Every mark the resume references, resolved once before the template runs.
  MARKS = prepareLogos([...new Set([...experience, ...education].map(e => e.meta[4]).filter(Boolean))]);

  const contact = {};
  for (const line of (resume.contact || '').split(/\r?\n/)) {
    const m = /^([^:]{1,24}):\s*(.+)$/.exec(line.trim());
    if (m) contact[m[1].trim().toLowerCase()] = m[2].trim();
  }

  const config = JSON.parse(read(join(ROOT, 'site.config.json')));

  /* "Website" names an address; "Portfolio" names the work waiting at it —
     older resumes wrote the former, so both keys are read. */
  const portfolio = contact.portfolio || contact.website;

  /* The four channels, each with an icon — the panel the reader must not miss.
     Ordered by what the reader is meant to do first: see the work, then the
     professional record behind it, and only then the two ways to reply. The
     panel is a two-column grid filling row by row, so this reads
     portfolio / linkedin across the top and email / phone underneath. */
  const channels = [
    ['portfolio', 'PORTFOLIO', pretty(portfolio), portfolio],
    ['linkedin', 'LINKEDIN', pretty(contact.linkedin), contact.linkedin],
    ['email', 'EMAIL', contact.email, 'mailto:' + contact.email],
    ['phone', 'PHONE', contact.phone, 'tel:' + String(contact.phone || '').replace(/[^\d+]/g, '')]
  ].filter(c => c[2]);

  const panel = `<div class="contact">${channels.map(([k, label, value, href]) =>
    `<a class="ch" href="${esc(href)}"><span class="chip">${icon(k)}</span>`
    + `<span class="txt"><span class="lbl">${label}</span><span class="val">${esc(value)}</span></span></a>`
  ).join('')}</div>`;

  const languages = entries(resume.languages).map(({ meta, bullets }) =>
    `<div class="line"><span class="line-a">${esc(meta[0])}</span><span class="line-b">${esc(meta[1])}</span></div>`
    + bullets.map(b => `<div class="note">${esc(b)}</div>`).join('')
  ).join('');

  const skillsHtml = skills(resume.skills).map(({ label, items }) =>
    `<div class="skill"><div class="skill-lbl">${esc(label)}</div>`
    + `<div class="tags">${items.map(i => `<span class="tag">${esc(i)}</span>`).join('')}</div></div>`
  ).join('');

  return `<meta charset="utf-8">
<title>${esc(config.name)} — CV</title>
<style>
  @page { size: A4; margin: 15mm 18mm 13mm; }

  :root {
    --ink:   #23262b;   /* names, headings, contact values */
    --body:  #45474a;   /* running text                    */
    --muted: #6d7075;   /* dates, small labels             */
    --rule:  #d8d8d6;   /* hairlines                       */
    --panel: #f4f4f1;   /* contact panel ground            */
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  body {
    font: 400 10.5px/1.55 "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif;
    color: var(--body);
    background: #fff;
    -webkit-font-smoothing: antialiased;
  }

  a { color: inherit; text-decoration: none; }

  /* ── masthead ──────────────────────────────────────────────────────── */

  header { border-bottom: 1.6px solid var(--ink); padding-bottom: 13px; }

  h1 { font-size: 32px; font-weight: 700; letter-spacing: -.4px; line-height: 1.05; color: var(--ink); }

  .role {
    margin-top: 8px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 2.7px;
    text-transform: uppercase;
    color: var(--muted);
  }

  /* ── contact panel ─────────────────────────────────────────────────── */

  .contact {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 13px 26px;
    margin: 17px 0 20px;
    padding: 16px 20px;
    background: var(--panel);
    border-left: 2.5px solid var(--ink);
  }

  .ch { display: flex; align-items: center; gap: 11px; }

  /* Solid ink chip: the glyph stays legible at print size and at a glance. */
  .chip {
    flex: none;
    width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
    background: var(--ink);
    color: #fff;
    border-radius: 5px;
  }

  .ic { width: 14px; height: 14px; display: block; }

  .txt { display: flex; flex-direction: column; min-width: 0; }

  .lbl { font-size: 7.4px; font-weight: 700; letter-spacing: 1.5px; color: var(--muted); line-height: 1.3; }

  .val { font-size: 12px; font-weight: 600; letter-spacing: -.05px; line-height: 1.35; color: var(--ink); }

  /* ── sections ──────────────────────────────────────────────────────── */

  .sec { margin-top: 34px; }

  /* Section headings outrank entry titles, so they have to read that way:
     larger, uppercase, and closed by a solid rule rather than a hairline —
     hairlines are what separate rows *inside* a section. */
  .sec h2 {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--ink);
    padding-bottom: 8px;
    margin-bottom: 15px;
    border-bottom: 2px solid var(--ink);
  }

  /* A hairline between entries: the generous gap then reads as structure
     rather than as a hole, which is what six stacked roles needs. */
  .item {
    display: flex;
    gap: 13px;
    break-inside: avoid;
    padding-bottom: 22px;
    margin-bottom: 22px;
    border-bottom: 1px solid var(--rule);
  }

  .item:last-child { padding-bottom: 0; margin-bottom: 0; border-bottom: 0; }

  .body { flex: 1 1 auto; min-width: 0; }

  /* No ring: prepareLogos() crops each mark onto white and it fills the
     circle edge to edge, so an outline only competes with the logo. */
  .mark {
    flex: none;
    width: 37px; height: 37px;
    margin-top: 1px;
    border-radius: 50%;
    background: #fff;
    overflow: hidden;
  }

  .mark img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .row { display: flex; align-items: baseline; gap: 14px; }

  .ttl { flex: 1 1 auto; font-size: 13.5px; font-weight: 700; letter-spacing: -.1px; color: var(--ink); }

  .when { flex: none; font-size: 9.5px; color: var(--muted); white-space: nowrap; }

  .org { margin-top: 3px; font-size: 10.5px; font-weight: 600; color: var(--body); }

  .item ul { list-style: none; margin-top: 7px; }

  .item li { position: relative; padding-left: 14px; font-size: 10.5px; line-height: 1.62; }

  /* En-dash marker rather than a disc — quieter against the hairlines. */
  .item li::before { content: "–"; position: absolute; left: 0; color: var(--muted); }

  /* ── skills ────────────────────────────────────────────────────────── */

  .skill { display: flex; gap: 16px; align-items: baseline; padding-bottom: 9px; }
  .skill:last-child { padding-bottom: 0; }

  .skill-lbl { flex: none; width: 92px; font-size: 9px; font-weight: 700; letter-spacing: 1.4px; color: var(--muted); }

  .tags { display: flex; flex-wrap: wrap; gap: 7px; }

  .tag {
    font-size: 10px;
    font-weight: 500;
    color: var(--ink);
    padding: 3.5px 9px;
    border: 1px solid var(--rule);
    border-radius: 3px;
  }

  /* ── line items ────────────────────────────────────────────────────── */

  .line {
    display: flex;
    align-items: baseline;
    gap: 14px;
    padding: 5px 0;
    border-bottom: 1px solid var(--rule);
    break-inside: avoid;
  }

  .line-a { flex: 1 1 auto; font-size: 11px; font-weight: 600; color: var(--ink); }

  .line-b { flex: none; font-size: 9.5px; color: var(--muted); white-space: nowrap; }

  .note { padding: 5px 0 6px; font-size: 9.8px; color: var(--body); border-bottom: 1px solid var(--rule); }

  /* Page two starts on its own footing rather than mid-section. */
  .break { break-before: page; }
</style>

<header>
  <h1>${esc(config.name)}</h1>
  <div class="role">${esc(config.role)}</div>
</header>

${panel}

${section('Experience', experience.map(block).join(''))}

<div class="break"></div>

${section('Education', education.map(block).join(''))}
${section('Skills', skillsHtml)}
${section('Certifications &amp; Courses', lines(entries(resume.certifications)))}
${section('Volunteering', lines(entries(resume.volunteering)))}
${section('Languages', languages)}
`;
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

const html = build();

const htmlPath = join(work, 'cv.html');
const pdfPath = join(ROOT, 'about', 'cv.pdf');
writeFileSync(htmlPath, html, 'utf8');

execFileSync(chrome(), [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-pdf-header-footer',
  '--run-all-compositor-stages-before-draw',
  '--virtual-time-budget=4000',
  `--print-to-pdf=${pdfPath}`,
  'file:///' + htmlPath.replace(/\\/g, '/')
], { stdio: 'ignore' });

if (process.argv.includes('--html')) writeFileSync(join(work, 'cv.kept.html'), html, 'utf8');
console.log('Wrote ' + pdfPath);
