#!/usr/bin/env node
/**
 * Scans the repository and writes content.json — plus the SEO surface that
 * has to be legible without running the page: the meta block and structured
 * data inside index.html, robots.txt and sitemap.xml.
 *
 * Nothing here is hand-maintained: drop a folder in projects/, a logo in
 * clients/, or a new cv.pdf in about/, and the next run picks it up.
 *
 * Run locally with:  node tools/build-content.mjs
 * CI runs it on every push (see .github/workflows/deploy.yml).
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg']);
const VIDEO = new Set(['.mp4', '.webm', '.mov', '.m4v']);

/* ── tiny helpers ─────────────────────────────────────────────────────── */

const read = p => readFileSync(p, 'utf8');
const isDir = p => existsSync(p) && statSync(p).isDirectory();
const posix = p => relative(ROOT, p).split(/[\\/]/).join('/');

const dirs = p => (isDir(p) ? readdirSync(p, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
  .map(d => d.name).sort(natural) : []);

const files = p => (isDir(p) ? readdirSync(p, { withFileTypes: true })
  .filter(d => d.isFile() && !d.name.startsWith('.'))
  .map(d => d.name).sort(natural) : []);

/** "02.jpg" sorts before "10.jpg" — plain sort would not. */
function natural(a, b) {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

/** Short content hash, used to bust caches when a file is replaced in place. */
function hash(p) {
  try { return createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 8); }
  catch { return null; }
}

/** "01-logos" -> "logos";  "03-spatial" -> "spatial" */
const unprefix = name => name.replace(/^\d+[-_.\s]*/, '');

const titleize = s => unprefix(s).replace(/[-_]+/g, ' ').trim();

/* ── front matter ─────────────────────────────────────────────────────── */

/**
 * Parses the YAML subset the project files actually use: `key: value`
 * scalars and `- item` lists. Deliberately not a full YAML parser — this
 * keeps the build dependency-free.
 */
function frontMatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };

  const data = {};
  let key = null;

  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;

    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && key) {
      (Array.isArray(data[key]) ? data[key] : (data[key] = [])).push(unquote(item[1]));
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw);
    if (!pair) continue;

    key = pair[1];
    const value = pair[2].trim();
    data[key] = value === '' ? [] : unquote(value);
  }

  return { data, body: src.slice(m[0].length) };
}

function unquote(v) {
  const s = String(v).trim().replace(/\s+#.*$/, '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

const list = v => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : []);

/** `true`, `yes`, `1`, `on` -> true. Anything else (including missing) -> false. */
const flag = v => /^(true|yes|y|1|on)$/i.test(String(v ?? '').trim());

/* ── self-initiated work ──────────────────────────────────────────────── */

/**
 * Names that stand in for "no client" — the project is still shown, with its
 * client line intact, but it is not an engagement and never reaches the
 * clients page. Add a spelling here and every project using it follows.
 */
const NON_CLIENT = new Set([
  'selfinitiated', 'selfinitiatedproject', 'self', 'personal', 'personalproject',
  'sideproject', 'inhouse', 'internal', 'none', 'na', 'nonentity'
]);

const normalize = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

const isNonClient = name => NON_CLIENT.has(normalize(name));

/* ── markdown ─────────────────────────────────────────────────────────── */

const escapeHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Inline markdown -> HTML. Links, bold, italic, code. Nothing else. */
function inline(md) {
  return escapeHtml(md)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
      const tag = text.replace(/[^A-Za-z0-9 ]/g, '').trim().toUpperCase().slice(0, 24) || 'LINK';
      const external = /^https?:/i.test(href);
      return `<a href="${href}"${external ? ' target="_blank" rel="noopener"' : ''} data-tag="${tag}">${text}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Splits a markdown body into `{ [heading]: html }`, keyed by lowercase heading. */
function sections(body) {
  const out = {};
  let key = '_intro';
  let buf = [];

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) {
      out[key] = text.split(/\n{2,}/).map(p => inline(p.trim().replace(/\n/g, ' '))).join('\n');
    }
    buf = [];
  };

  for (const line of body.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { flush(); key = h[1].trim().toLowerCase(); }
    else buf.push(line);
  }
  flush();
  return out;
}

/** Splits a markdown body into `{ [heading]: rawText }`, keyed by lowercase
 *  heading. Same walk as `sections`, but the text is left alone — line breaks
 *  survive, which is what a "one group per line" list needs. */
function rawSections(body) {
  const out = {};
  let key = '_intro';
  let buf = [];

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) out[key] = text;
    buf = [];
  };

  for (const line of body.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { flush(); key = h[1].trim().toLowerCase(); }
    else buf.push(line);
  }
  flush();
  return out;
}

/** First section matching any of `names`, else null. */
const pick = (secs, names) => {
  for (const n of names) if (secs[n]) return secs[n];
  return null;
};

/* ── projects ─────────────────────────────────────────────────────────── */

/** Sensible defaults so the four shipped categories keep their labels.
 *  `spatial` is the former `3d` and `xr` under one roof — an object and the
 *  environment it lives in are one practice, not two. */
const CATEGORY_DEFAULTS = {
  logos:   { sub: 'MARKS & IDENTITY',    kind: 0 },
  posters: { sub: 'PRINT & EDITORIAL',   kind: 1 },
  spatial: { sub: 'FORM & ENVIRONMENT',  kind: 2 },
  motion:  { sub: 'TIME & SEQUENCE',     kind: 3 }
};

function readCategory(dir, name, index) {
  const slug = unprefix(name).toLowerCase();
  const fallback = CATEGORY_DEFAULTS[slug] || {};
  let data = {};

  for (const candidate of ['category.md', 'index.md', 'category.yml']) {
    const p = join(dir, candidate);
    if (existsSync(p)) { data = frontMatter(read(p)).data; break; }
  }

  return {
    key: String(data.key || data.title || titleize(name)).toUpperCase(),
    sub: String(data.sub || fallback.sub || titleize(name)).toUpperCase(),
    kind: Number.isFinite(+data.kind) && data.kind !== ''
      ? +data.kind
      : (fallback.kind ?? index % 4),
    order: Number.isFinite(+data.order) && data.order !== '' ? +data.order : index
  };
}

function readProject(dir, folder) {
  const mdName = files(dir).find(f => f.toLowerCase() === 'index.md')
    || files(dir).find(f => extname(f).toLowerCase() === '.md');

  const { data, body } = mdName ? frontMatter(read(join(dir, mdName))) : { data: {}, body: '' };
  const secs = sections(body);

  const all = files(dir);
  const images = all.filter(f => IMAGE.has(extname(f).toLowerCase()));
  const videos = all.filter(f => VIDEO.has(extname(f).toLowerCase()));

  // A named cover wins; otherwise anything called cover.*; otherwise the first image.
  const named = data.cover && images.find(f => f.toLowerCase() === String(data.cover).toLowerCase());
  const conventional = images.find(f => /^cover\./i.test(f));
  const cover = named || conventional || images[0] || null;

  const gallery = images.filter(f => f !== cover).map(f => posix(join(dir, f)));

  // "client" (singular, one name) and "clients" (plural, a list) can each be
  // written as a string or a list in front matter — normalize both into one
  // deduped list, then decide the shape from the count, not from which key
  // was used. This is what lets the page show "CLIENT" for one name and
  // "CLIENTS" for more than one, consistently.
  const clientNames = [...new Set([...list(data.client), ...list(data.clients)])];

  const work = {
    slug: folder,
    t: String(data.title || titleize(folder)).toUpperCase(),
    c: clientNames.length === 1 ? clientNames[0] : '',
    y: String(data.year || ''),
    r: data.role || '',

    img: cover ? posix(join(dir, cover)) : null,
    video: videos[0] ? posix(join(dir, videos[0])) : null,
    gallery,

    link: data.link || null,
    tag: data.tag ? String(data.tag).toUpperCase() : null,
    lb: data.label_overview ? String(data.label_overview).toUpperCase() : null,
    la: data.label_contribution ? String(data.label_contribution).toUpperCase() : null,

    b: pick(secs, ['overview', 'brief', 'about', '_intro']) || '',
    a: pick(secs, ['contribution', 'approach', 'process', 'role']) || '',
    credit: pick(secs, ['credit', 'credits', 'thanks']) || null,

    clients: clientNames.length > 1 ? clientNames : [],
    roles: list(data.roles),

    // Self-initiated: either said so in front matter (`self_initiated: true`,
    // or `engagement: false`), or every name given is a stand-in like
    // "Self-Initiated". Such a project is listed as work, never as a client.
    self: flag(data.self_initiated) || flag(data.personal)
      || (data.engagement !== undefined && !flag(data.engagement))
      || (clientNames.length > 0 && clientNames.every(isNonClient))
  };

  if (!work.self) delete work.self;
  if (!work.clients.length) delete work.clients;
  if (!work.roles.length) delete work.roles;

  return work;
}

function buildFields(config) {
  const base = join(ROOT, 'projects');
  const fields = [];

  dirs(base).forEach((name, i) => {
    const dir = join(base, name);
    const meta = readCategory(dir, name, i);

    // newest year first; undated projects sink to the bottom. Ties (same
    // year, or both undated) break alphabetically by title — no manual
    // ordering to maintain, a new project just slots in where its year puts it.
    const works = dirs(dir)
      .map(f => readProject(join(dir, f), f))
      .sort((a, b) => {
        const ya = parseInt(a.y, 10), yb = parseInt(b.y, 10);
        const fa = Number.isFinite(ya) ? ya : -Infinity;
        const fb = Number.isFinite(yb) ? yb : -Infinity;
        return fb - fa || a.t.localeCompare(b.t, 'en', { sensitivity: 'base', numeric: true });
      });

    if (!works.length && !config.show_empty_categories) return;
    fields.push({ ...meta, works });
  });

  return fields.sort((a, b) => a.order - b.order);
}

/* ── models ───────────────────────────────────────────────────────────── */

/**
 * Inventories model/. `logo.glb` is the form the site loads with and is
 * reported separately; everything else is a form it can morph into, in
 * natural order. Nothing is numbered or registered by hand — drop a .glb in
 * the folder and the next run picks it up, however many there are.
 */
const MODEL_PRIMARY = 'logo.glb';

function buildModels() {
  const dir = join(ROOT, 'model');
  const all = files(dir).filter(f => /\.(glb|gltf)$/i.test(f));
  const primary = all.find(f => f.toLowerCase() === MODEL_PRIMARY);
  return {
    primary: primary || null,
    alts: all.filter(f => f !== primary)
  };
}

/* ── clients ──────────────────────────────────────────────────────────── */

function buildClients() {
  const dir = join(ROOT, 'clients');
  return files(dir)
    .filter(f => IMAGE.has(extname(f).toLowerCase()))
    .map(f => ({
      // "Tardid - Virtual Philosophy School.png": the dashes become spaces,
      // and the spaces already around them would otherwise stay as a gap.
      name: basename(f, extname(f)).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim(),
      src: posix(join(dir, f))
    }));
}

/**
 * Every client project doubles as an engagement row — no second list to
 * maintain. Self-initiated work is skipped: it has no client to credit.
 */
function buildEngagements(fields) {
  const rows = [];
  for (const f of fields) {
    for (const w of f.works) {
      if (w.self) continue;
      const client = (w.clients && w.clients[0]) || w.c;
      if (!client || isNonClient(client)) continue;
      const scope = (w.roles && w.roles[0]) || w.r || f.key;
      rows.push({ name: String(client).toUpperCase(), scope: String(scope).toUpperCase(), year: w.y });
    }
  }
  const seen = new Set();
  return rows
    .filter(r => {
      const id = `${r.name}|${r.scope}|${r.year}`;
      return seen.has(id) ? false : (seen.add(id), true);
    })
    .sort((a, b) => (b.year || '').localeCompare(a.year || ''));
}

/* ── about ────────────────────────────────────────────────────────────── */

/**
 * Reads the "## Skills" section. One group per line:
 *
 *   Disciplines: Logo Design, Poster Design, 3D Design
 *   Software: Figma, Blender 3D
 *
 * A line with no label lands in an unlabelled group, so a plain
 * comma-separated list still works. Returns `[{ label, items }]`.
 */
function readSkills(body) {
  const raw = pick(rawSections(body), ['skills', 'skill', 'toolkit']);
  if (!raw) return [];

  const groups = [];

  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim().replace(/^[-*]\s+/, '');
    if (!text) continue;

    const pair = /^([^:]{1,48}):\s*(.+)$/.exec(text);
    const label = pair ? pair[1].trim().toUpperCase() : '';
    const items = (pair ? pair[2] : text)
      .split(/\s*[,;|]\s*/).map(s => s.trim()).filter(Boolean);
    if (!items.length) continue;

    const existing = groups.find(g => g.label === label);
    if (existing) existing.items.push(...items);
    else groups.push({ label, items });
  }

  return groups;
}

/**
 * Splits a raw section into entries. A `|`-delimited line starts a new
 * entry (a trailing `-` field means "none"); any non-`|` lines under it,
 * each stripped of a leading `-`/`*` marker, are its bullets. Blank lines
 * are just breathing room — entries may sit right on top of each other
 * (certifications, one per line) or have bullets under them (experience).
 */
function entryBlocks(raw) {
  if (!raw) return [];
  const entries = [];
  let current = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.includes('|')) {
      current = {
        meta: line.split('|').map(s => { const v = s.trim(); return v === '-' ? '' : v; }),
        bullets: []
      };
      entries.push(current);
    } else if (current) {
      current.bullets.push(line.replace(/^[-*]\s+/, ''));
    }
  }
  return entries;
}

/**
 * Reads the CV/résumé content out of `about/resume.md`, a hand-maintained
 * companion to `about.md` — the two are kept apart so the short bio (read
 * by every visitor) doesn't get lost in the long, form-heavy resume data.
 * Takes the file's body; returns null when there is nothing in it, so the
 * page and its nav entry can both stay out of the way until there is
 * something to show.
 */
function readResume(body) {
  if (!body) return null;

  const secs = rawSections(body);

  const experience = entryBlocks(secs.experience).map(({ meta, bullets }) => ({
    role: meta[0] || '', org: meta[1] || '', dates: meta[2] || '',
    link: meta[3] || null, bullets
  }));

  const education = entryBlocks(secs.education).map(({ meta, bullets }) => ({
    degree: meta[0] || '', school: meta[1] || '', dates: meta[2] || '',
    link: meta[3] || null, bullets
  }));

  const certifications = entryBlocks(secs.certifications).map(({ meta }) => ({
    title: meta[0] || '', org: meta[1] || '', date: meta[2] || '', link: meta[3] || null
  }));

  const volunteering = entryBlocks(secs.volunteering).map(({ meta }) => ({
    role: meta[0] || '', org: meta[1] || '', dates: meta[2] || '', link: meta[3] || null
  }));

  const languages = entryBlocks(secs.languages).map(({ meta, bullets }) => ({
    name: meta[0] || '', level: meta[1] || '', bullets
  }));

  const contact = {};
  for (const line of (secs.contact || '').split(/\r?\n/)) {
    const pair = /^([^:]{1,24}):\s*(.+)$/.exec(line.trim());
    if (pair) contact[pair[1].trim().toLowerCase()] = pair[2].trim();
  }

  const hasAny = experience.length || education.length || certifications.length
    || volunteering.length || languages.length || Object.keys(contact).length;
  if (!hasAny) return null;

  return { experience, education, certifications, volunteering, languages, contact };
}

function buildAbout(config) {
  const dir = join(ROOT, 'about');
  const all = files(dir);

  const portraitFile = all.find(f => /^(me|portrait|profile)\./i.test(f))
    || all.find(f => IMAGE.has(extname(f).toLowerCase()));

  const mdName = all.find(f => /^(about|index|bio)\.md$/i.test(f));
  const { data, body } = mdName ? frontMatter(read(join(dir, mdName))) : { data: {}, body: '' };
  const secs = sections(body);

  // resume.md carries the CV data *and*, since it is the file that gets
  // edited whenever the toolkit changes, the skill groups. about.md is still
  // read as a fallback so a copy of the content that predates the move keeps
  // rendering its skills.
  const resumeName = all.find(f => /^resume\.md$/i.test(f));
  const resumeBody = resumeName ? frontMatter(read(join(dir, resumeName))).body : '';
  const resumeSkills = readSkills(resumeBody);

  const cvFile = all.find(f => /\.pdf$/i.test(f) && /^(cv|resume|resumé)\./i.test(f))
    || all.find(f => /\.pdf$/i.test(f));

  let cv = null;
  if (cvFile) {
    const p = join(dir, cvFile);
    cv = {
      src: posix(p),
      hash: hash(p),
      updated: statSync(p).mtime.toISOString().slice(0, 10),
      size: Math.max(1, Math.round(statSync(p).size / 1024)) + ' KB'
    };
  }

  const paragraphs = Object.entries(secs)
    .filter(([k]) => k === '_intro' || k === 'bio' || k === 'about')
    .map(([, v]) => v)
    .join('\n')
    .split('\n')
    .filter(Boolean);

  return {
    portrait: portraitFile ? posix(join(dir, portraitFile)) : null,
    caption: String(data.caption || config.name || '').toUpperCase(),
    headline: data.headline || '',
    paragraphs,
    skills: resumeSkills.length ? resumeSkills : readSkills(body),
    practice: secs.practice || null,
    resume: readResume(resumeBody),
    cv
  };
}

/* ── config ───────────────────────────────────────────────────────────── */

function loadConfig() {
  const p = join(ROOT, 'site.config.json');
  const defaults = {
    name: '', role: '', email: '', links: {}, details: {},
    url: '', brand: '', description: '', og_image: '',
    clients_lede: '', show_empty_categories: false
  };
  if (!existsSync(p)) return defaults;
  try { return { ...defaults, ...JSON.parse(read(p)) }; }
  catch (err) {
    console.error('site.config.json is not valid JSON — using defaults.\n ', err.message);
    return defaults;
  }
}

/* ── seo ──────────────────────────────────────────────────────────────── */

/**
 * index.html is one URL whose body is drawn entirely by JavaScript, so
 * anything that does not run scripts — a social-card scraper, a crawler that
 * skips rendering, a reader with scripting off — would see the boot screen
 * and nothing else. The data that feeds the runtime is therefore written out
 * three more ways: the <head> meta block, a plain-HTML copy of the site
 * inside <noscript>, and schema.org structured data. index.html carries the
 * SEO markers; everything between them is regenerated here on every build,
 * so none of it is kept in step by hand.
 *
 * The email address is deliberately absent from all of it — see the note in
 * site.config.json. It is the one thing on the page a scraper must not find.
 */

const SEO_HEAD = ['<!-- SEO:HEAD:START -->', '<!-- SEO:HEAD:END -->'];
const SEO_BODY = ['<!-- SEO:BODY:START -->', '<!-- SEO:BODY:END -->'];

/** Replaces what sits between a marker pair, leaving the markers in place. */
function region(html, [open, close], inner) {
  const a = html.indexOf(open);
  const b = html.indexOf(close, a);
  if (a < 0 || b < 0) throw new Error(`index.html is missing ${open} … ${close}`);
  return html.slice(0, a + open.length) + '\n' + inner.trim() + '\n' + html.slice(b);
}

/**
 * Pixel size of a PNG, JPEG or WebP, read from the header alone — the card
 * scrapers render a placeholder of the right shape when they are told the
 * dimensions up front, and guess (usually wrongly) when they are not.
 * Returns null for anything it does not recognise, and the tags are dropped.
 */
function imageSize(p) {
  let b;
  try { b = readFileSync(p); } catch { return null; }

  if (b.length > 24 && b.toString('latin1', 1, 4) === 'PNG') {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }

  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xFF) { i++; continue; }
      const marker = b[i + 1];
      // SOF0–SOF15, minus the three that are not frame headers at all.
      if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
        return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }

  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    // Every WebP flavour stores its size somewhere different, and all three
    // are minus-one encoded except the lossy one.
    if (chunk === 'VP8X') return { w: (b.readUIntLE(24, 3) & 0xFFFFFF) + 1, h: (b.readUIntLE(27, 3) & 0xFFFFFF) + 1 };
    if (chunk === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3FFF, h: b.readUInt16LE(28) & 0x3FFF };
    if (chunk === 'VP8L') {
      const n = b.readUInt32LE(21);
      return { w: (n & 0x3FFF) + 1, h: ((n >> 14) & 0x3FFF) + 1 };
    }
  }

  return null;
}

/** Strips tags out of the already-rendered bio HTML for use in plain text. */
const plain = html => String(html || '')
  .replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

const OG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };

/* WebP is deliberately absent: Telegram and WhatsApp will not render a WebP
   preview, so a card in that format silently shows no image at all. */
const mimeOf = p => OG_MIME[extname(String(p || '')).toLowerCase()] || '';

const metaTag = (key, value, attr = 'name') =>
  (value === '' || value == null ? '' : `<meta ${attr}="${key}" content="${escapeHtml(String(value))}">`);

/** Drops the empties, so an unset config field leaves no blank tag behind. */
const tags = (...lines) => lines.filter(Boolean).join('\n');

function seoHead(config, content, abs) {
  const title = [config.name, config.role].filter(Boolean).join(' — ');
  const desc = config.description || plain((content.about.paragraphs || [])[0]);
  const brand = config.brand || config.name;
  const home = abs('');
  const img = abs(config.og_image);
  const size = config.og_image ? imageSize(join(ROOT, config.og_image)) : null;
  const alt = [config.name, config.role].filter(Boolean).join(', ');

  const identity = tags(
    `<title>${escapeHtml(title)}</title>`,
    metaTag('description', desc),
    home ? `<link rel="canonical" href="${escapeHtml(home)}">` : '',
    metaTag('author', config.name),
    metaTag('application-name', brand),
    metaTag('robots', 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'),
    metaTag('color-scheme', 'dark light'),
    '<meta name="theme-color" content="#070708" media="(prefers-color-scheme: dark)">',
    '<meta name="theme-color" content="#edebe6" media="(prefers-color-scheme: light)">'
  );

  /* og:site_name is what a search engine reads the site's *brand* off, which
     is why the title itself can stay the person's name and stop there. */
  /* Everything a link preview is built from. The scrapers that matter here
     are not browsers and do not run the page: Telegram, WhatsApp, LinkedIn,
     Slack and Facebook each fetch the HTML, read this block, and stop — which
     is why it sits at the very top of <head>, well inside the first few
     hundred kilobytes WhatsApp's crawler bothers to read.

     og:image has to be an absolute URL for all of them; the explicit width
     and height are what get LinkedIn to draw the large card instead of the
     small thumbnail; secure_url is what LinkedIn and Facebook look for over
     https; and the type spares WhatsApp having to sniff the bytes. */
  const openGraph = tags(
    metaTag('og:type', 'website', 'property'),
    metaTag('og:site_name', brand, 'property'),
    metaTag('og:locale', 'en_US', 'property'),
    metaTag('og:url', home, 'property'),
    metaTag('og:title', title, 'property'),
    metaTag('og:description', desc, 'property'),
    metaTag('og:image', img, 'property'),
    img && /^https:/i.test(img) ? metaTag('og:image:secure_url', img, 'property') : '',
    img ? metaTag('og:image:type', mimeOf(config.og_image), 'property') : '',
    size ? metaTag('og:image:width', size.w, 'property') : '',
    size ? metaTag('og:image:height', size.h, 'property') : '',
    img ? metaTag('og:image:alt', alt, 'property') : ''
  );

  const twitter = tags(
    metaTag('twitter:card', img ? 'summary_large_image' : 'summary'),
    metaTag('twitter:title', title),
    metaTag('twitter:description', desc),
    metaTag('twitter:image', img),
    img ? metaTag('twitter:image:alt', alt) : ''
  );

  return [identity, openGraph, twitter].filter(Boolean).join('\n\n');
}

/* ── the no-script copy ───────────────────────────────────────────────── */

/**
 * A flat, styled-in-CSS rendering of everything the panels would show: the
 * bio, the skill groups, every project under its field, the client list and
 * the way out to the CV. It is the site as a document rather than as an
 * instrument, and it is what a crawler that never runs the module reads.
 */
function seoNoscript(config, content, abs) {
  const { site, about, clients, fields } = content;
  const based = (site.details && (site.details['BASED IN'] || site.details['Based in'])) || '';

  /* The document's <h1> is the name in the HUD, which without scripting is
     stranded under the boot screen — so the copy repeats it in a <p> rather
     than a second <h1>, and the heading outline stays as it should be. */
  const head = `<p class="seo-name">${escapeHtml(site.name)}</p>\n`
    + `<p class="seo-role">${escapeHtml([site.role, based].filter(Boolean).join(' · '))}</p>`;

  // Already HTML — sections() ran the markdown through inline() on the way in.
  const bio = (about.paragraphs || []).map(p => `<p>${p}</p>`).join('\n');

  const skills = (about.skills || []).length
    ? '<h2>Skills</h2>\n' + about.skills
      .map(g => `<h3>${escapeHtml(g.label || 'SKILLS')}</h3>\n<p>${escapeHtml(g.items.join(', '))}</p>`)
      .join('\n')
    : '';

  const work = fields.length
    ? '<h2>Selected work</h2>\n' + fields.map(f => {
      const items = f.works.map(w => {
        const note = [w.self ? 'Self-initiated' : (w.clients && w.clients[0]) || w.c, w.y]
          .filter(Boolean).join(', ');
        const caption = escapeHtml([w.t, note].filter(Boolean).join(' — '));
        const shot = w.img
          ? `<img src="${escapeHtml(w.img)}" alt="${caption}" loading="lazy" decoding="async" width="240">`
          : '';
        return `<li>${shot}<span>${caption}</span></li>`;
      }).join('\n');
      return `<h3>${escapeHtml(f.key)} — ${escapeHtml(f.sub)}</h3>\n<ul class="seo-work">\n${items}\n</ul>`;
    }).join('\n')
    : '';

  const logos = (clients.logos || []).length
    ? '<h2>Clients</h2>\n<ul>' +
      clients.logos.map(l => `<li>${escapeHtml(l.name)}</li>`).join('') + '</ul>'
    : '';

  /* Links only. The address is assembled in the browser and stays out of
     every file that ships — a plain mailto here would undo all of that. */
  const elsewhere = Object.entries(site.links || {});
  const reach = '<h2>Contact</h2>\n' +
    (elsewhere.length
      ? '<ul>' + elsewhere.map(([k, v]) =>
        `<li><a href="${escapeHtml(v)}" rel="me noopener">${escapeHtml(k)}</a></li>`).join('') + '</ul>'
      : '') +
    (about.cv ? `\n<p><a href="${escapeHtml(about.cv.src)}">Curriculum vitae (PDF)</a></p>` : '') +
    '\n<p>Enable JavaScript for the interactive version of this site.</p>';

  return '<noscript>\n<div class="seo">\n'
    + [head, bio, skills, work, logos, reach].filter(Boolean).join('\n\n')
    + '\n</div>\n</noscript>';
}

/* ── structured data ──────────────────────────────────────────────────── */

/**
 * One @graph rather than several loose blocks, so the person, the site, the
 * page and the work all point at each other by @id instead of being restated.
 */
function seoJsonLd(config, content, abs) {
  const { site, about, fields } = content;
  const home = abs('');
  const brand = config.brand || config.name;
  const desc = config.description || plain((about.paragraphs || [])[0]);
  const based = (site.details && site.details['BASED IN']) || '';
  const [city, country] = based.split(',').map(s => s.trim());

  const person = {
    '@type': 'Person',
    '@id': home + '#person',
    name: config.name,
    alternateName: brand,
    url: home,
    jobTitle: config.role,
    description: plain((about.paragraphs || []).join(' ')) || desc,
    knowsAbout: [
      ...(about.skills || []).flatMap(g => g.items),
      ...fields.map(f => f.key.toLowerCase())
    ],
    sameAs: Object.values(site.links || {})
  };

  if (about.portrait) person.image = abs(about.portrait);
  if (city) person.address = { '@type': 'PostalAddress', addressLocality: city, addressCountry: country || undefined };

  const schools = ((about.resume && about.resume.education) || [])
    .map(e => e.school).filter(Boolean);
  if (schools.length) {
    person.alumniOf = [...new Set(schools)].map(name => ({ '@type': 'CollegeOrUniversity', name }));
  }

  // worksFor means *now*. A role that has already ended belongs in a graph
  // that can carry dates, not in a flat list that reads as current, so only
  // the open-ended ones are declared.
  const employers = ((about.resume && about.resume.experience) || [])
    .filter(e => /present|current|ongoing/i.test(e.dates))
    .map(e => e.org.split('·')[0].trim())
    .filter(Boolean);
  if (employers.length) {
    person.worksFor = [...new Set(employers)].map(name => ({ '@type': 'Organization', name }));
  }

  const website = {
    '@type': 'WebSite',
    '@id': home + '#website',
    url: home,
    name: brand,
    alternateName: config.name,
    description: desc,
    inLanguage: 'en',
    publisher: { '@id': home + '#person' }
  };

  const page = {
    '@type': 'ProfilePage',
    '@id': home + '#webpage',
    url: home,
    name: [config.name, config.role].filter(Boolean).join(' — '),
    description: desc,
    inLanguage: 'en',
    isPartOf: { '@id': home + '#website' },
    about: { '@id': home + '#person' },
    mainEntity: { '@id': home + '#person' }
  };
  if (about.portrait) page.primaryImageOfPage = abs(about.portrait);

  /* Every project as a work with a named creator — the part of the graph a
     portfolio actually has to say out loud, since none of it is in the HTML. */
  const works = fields.flatMap(f => f.works.map(w => {
    const item = {
      '@type': 'CreativeWork',
      name: w.t,
      genre: f.key.toLowerCase(),
      creator: { '@id': home + '#person' },
      url: home
    };
    if (w.y) item.dateCreated = w.y;
    if (w.img) item.image = abs(w.img);
    if (w.b) item.abstract = plain(w.b).slice(0, 300);
    const client = (w.clients && w.clients[0]) || w.c;
    if (client && !w.self) item.sourceOrganization = { '@type': 'Organization', name: client };
    return item;
  }));

  const portfolio = works.length ? [{
    '@type': 'ItemList',
    '@id': home + '#work',
    name: 'Selected work',
    numberOfItems: works.length,
    itemListElement: works.map((w, i) => ({ '@type': 'ListItem', position: i + 1, item: w }))
  }] : [];

  const graph = { '@context': 'https://schema.org', '@graph': [website, page, person, ...portfolio] };

  // "</" anywhere inside the JSON would close the script tag early.
  return '<script type="application/ld+json">\n'
    + JSON.stringify(graph, null, 2).replace(/<\//g, '<\\/')
    + '\n</script>';
}

/* ── robots and sitemap ───────────────────────────────────────────────── */

function writeRobots(abs) {
  const home = abs('');
  const body = [
    '# https://kiarad.space — one page, everything on it public.',
    'User-agent: *',
    'Allow: /',
    '',
    '# Nothing here for a crawler; they are build inputs and scratch space.',
    'Disallow: /tools/',
    ''
  ];
  if (home) body.push('Sitemap: ' + home + 'sitemap.xml', '');
  writeFileSync(join(ROOT, 'robots.txt'), body.join('\n'));
}

/**
 * One URL, and every piece of artwork on it declared as an image for that
 * URL. A portfolio's covers and galleries are the thing worth finding, and
 * a single-page site gives image search no other way to find them.
 */
function writeSitemap(content, abs) {
  const home = abs('');
  if (!home) return 0;

  const seen = new Set();
  const images = [];
  for (const f of content.fields) {
    for (const w of f.works) {
      for (const src of [w.img, ...(w.gallery || [])]) {
        if (!src || seen.has(src)) continue;
        seen.add(src);
        images.push({ loc: abs(src), title: `${w.t} — ${f.key.toLowerCase()}` });
      }
    }
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    '  <url>',
    `    <loc>${escapeHtml(home)}</loc>`,
    `    <lastmod>${content.generated.slice(0, 10)}</lastmod>`,
    '    <changefreq>monthly</changefreq>',
    '    <priority>1.0</priority>',
    ...images.map(i =>
      '    <image:image>\n' +
      `      <image:loc>${escapeHtml(i.loc)}</image:loc>\n` +
      `      <image:title>${escapeHtml(i.title)}</image:title>\n` +
      '    </image:image>'),
    '  </url>',
    '</urlset>',
    ''
  ].join('\n');

  writeFileSync(join(ROOT, 'sitemap.xml'), xml);
  return images.length;
}

/** Rewrites both marked regions of index.html and writes robots + sitemap. */
function writeSeo(config, content) {
  const origin = String(config.url || '').replace(/\/+$/, '');
  // encodeURI on the way out, so a filename with a space in it still yields
  // a URL a validator will take.
  const abs = p => (!origin ? ''
    : !p ? origin + '/'
    : /^https?:/i.test(p) ? p
    : origin + '/' + encodeURI(String(p).replace(/^\/+/, '')));

  const p = join(ROOT, 'index.html');
  let html = read(p);
  html = region(html, SEO_HEAD, seoHead(config, content, abs));
  html = region(html, SEO_BODY, seoNoscript(config, content, abs) + '\n\n' + seoJsonLd(config, content, abs));
  writeFileSync(p, html);

  writeRobots(abs);
  const images = writeSitemap(content, abs);

  if (!origin) console.warn('  site.config.json has no "url" — canonical, sitemap and robots left incomplete.');
  return images;
}

/* ── main ─────────────────────────────────────────────────────────────── */

const config = loadConfig();
const fields = buildFields(config);
const clients = buildClients();
const models = buildModels();

const content = {
  generated: new Date().toISOString(),
  site: {
    name: config.name,
    role: config.role,
    email: config.email,
    links: config.links,
    details: config.details
  },
  about: buildAbout(config),
  clients: { lede: config.clients_lede, logos: clients, engagements: buildEngagements(fields) },
  models,
  fields
};

writeFileSync(join(ROOT, 'content.json'), JSON.stringify(content, null, 2) + '\n');

const indexed = writeSeo(config, content);

const works = fields.reduce((n, f) => n + f.works.length, 0);
console.log(
  `content.json written\n` +
  `  ${fields.length} categories, ${works} projects, ${clients.length} client logos\n` +
  `  cv: ${content.about.cv ? content.about.cv.src + ' (updated ' + content.about.cv.updated + ')' : 'none found'}\n` +
  `  seo: index.html meta + JSON-LD, robots.txt, sitemap.xml (${indexed} images)\n` +
  `  models: ${models.primary || 'model/' + MODEL_PRIMARY + ' MISSING'}` +
  ` + ${models.alts.length} to morph into${models.alts.length ? ' (' + models.alts.join(', ') + ')' : ''}`
);
for (const f of fields) {
  console.log(`  ${f.key.padEnd(10)} ${f.works.map(w => w.slug).join(', ') || '(empty)'}`);
}
