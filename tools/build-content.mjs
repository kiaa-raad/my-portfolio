#!/usr/bin/env node
/**
 * Scans the repository and writes content.json.
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
      name: basename(f, extname(f)).replace(/[-_]+/g, ' ').trim(),
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
 * Returns null when the file is absent, so the page and its nav entry can
 * both stay out of the way until there is something to show.
 */
function readResume(dir, all) {
  const name = all.find(f => /^resume\.md$/i.test(f));
  if (!name) return null;

  const { body } = frontMatter(read(join(dir, name)));
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
    skills: readSkills(body),
    practice: secs.practice || null,
    resume: readResume(dir, all),
    cv
  };
}

/* ── config ───────────────────────────────────────────────────────────── */

function loadConfig() {
  const p = join(ROOT, 'site.config.json');
  const defaults = {
    name: '', role: '', email: '', links: {}, details: {},
    clients_lede: '', show_empty_categories: false
  };
  if (!existsSync(p)) return defaults;
  try { return { ...defaults, ...JSON.parse(read(p)) }; }
  catch (err) {
    console.error('site.config.json is not valid JSON — using defaults.\n ', err.message);
    return defaults;
  }
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

const works = fields.reduce((n, f) => n + f.works.length, 0);
console.log(
  `content.json written\n` +
  `  ${fields.length} categories, ${works} projects, ${clients.length} client logos\n` +
  `  cv: ${content.about.cv ? content.about.cv.src + ' (updated ' + content.about.cv.updated + ')' : 'none found'}\n` +
  `  models: ${models.primary || 'model/' + MODEL_PRIMARY + ' MISSING'}` +
  ` + ${models.alts.length} to morph into${models.alts.length ? ' (' + models.alts.join(', ') + ')' : ''}`
);
for (const f of fields) {
  console.log(`  ${f.key.padEnd(10)} ${f.works.map(w => w.slug).join(', ') || '(empty)'}`);
}
