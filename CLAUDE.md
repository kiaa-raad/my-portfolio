# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build     # node tools/build-content.mjs — regenerates content.json, the SEO
                  # regions inside index.html, robots.txt and sitemap.xml
npm start         # build, then npx --yes serve .
npm run cv        # about/<cv_filename>.pdf, and .<lang>.pdf, from about/resume.<lang>.md,
                  # one pass per declared language     (needs headless Chrome)
npm run og        # og.png link-preview card            (needs headless Chrome)
npm run studio    # serve on :3579, then open
                  #   http://localhost:3579/tools/linkedin-studio.html
                  # the LinkedIn banner, composed by hand against the live hero
```

No dependencies, no `npm install`, no bundler, no test suite, no linter. `three` is
pulled from unpkg through an importmap in `index.html`, so **the page must be served
over HTTP** — opening `index.html` from the filesystem breaks both the module graph
and the `fetch('content.json')` that draws the whole interface.

`.claude/launch.json` serves the directory on port 3579.

## Architecture

### index.html is two things at once

It is a ~5000-line hand-written single-file app **and** a build output. Four marker
comments divide them:

- `<!-- SEO:HEAD:START -->` … `<!-- SEO:HEAD:END -->` — the `<head>` meta block
- `<!-- SEO:BODY:START -->` … `<!-- SEO:BODY:END -->` — a plain-HTML `<noscript>`
  mirror of the site plus schema.org JSON-LD

Everything **between** those markers is overwritten wholesale on every `npm run build`.
Everything **outside** them — the `<style>` block and the single `<script type="module">`
— is hand-maintained and the build never touches it. Edit accordingly.

The `<noscript>` mirror exists because the body is drawn entirely by JavaScript: a
crawler or card scraper that does not run scripts would otherwise see only the boot
screen.

### Content pipeline

`tools/build-content.mjs` scans the repo and writes everything else:

```
site.config.json          ─┐                       content.json       (en, fetched at runtime)
projects/NN-cat/slug/*.md  ├─> build-content.mjs ─> content.fr.json
about/about.md             │                        index.html SEO regions
about/resume.md            │                        robots.txt
clients/*.png             ─┘                        sitemap.xml
```

Nothing in those outputs is hand-maintained. The script is deliberately
dependency-free — it hand-rolls the front-matter and markdown subset it needs — so CI
can run it anywhere.

`site.config.json` is the source of truth for name, role, URL, links, and details.
`content.json` is what the live page reads.

### Two languages, one document

The site is served in English and French. Which languages exist is declared once, in
`site.config.json` under `i18n`; everything else follows from that list.

- **The build runs once per language.** The default language keeps the plain
  `content.json`; the others are written beside it as `content.<lang>.json`.
- **A translation is a sibling file**: `index.fr.md` next to `index.md`,
  `about.fr.md` next to `about.md`, `category.fr.md` next to `category.md`. It is read
  as an **overlay**, not a replacement — front matter keys it does not mention keep the
  base file's value, and an empty body falls back whole. So a translation carries the
  prose and nothing else; `year`, `cover`, `order` and `link` stay written down once.
  A half-finished translation is a legitimate state.
- **Section headings may be translated too.** `HEADING_ALIAS` in the build maps
  `## Aperçu` onto `overview`, `## Approche` onto `contribution`, and so on. The
  heading is never rendered — the visible label is
  `label_overview` / `label_contribution`.
- **Per-language config** lives in `site.config.json` under `locales`. It is a shallow
  merge, so `details` and `client_names` replace their whole object: their keys are
  themselves display text, and half of one table with half of another is nonsense.
  `client_names` is the only place a client can be renamed for a language — a filename
  in `clients/` cannot carry a translation.
- **Interface strings are not content.** They live in `STRINGS` at the top of the
  module in `index.html`, because they have no markdown file to come from. A new
  project never touches that table and a new label never touches `projects/`.
- **Identifiers stay English.** `PAGES.ABOUT`, `data-page="ABOUT"`, a shape's `key`, a
  verb's index — the code holds onto names; what a visitor reads is looked up from them
  when it is painted.
- **The language is a query parameter**, `?lang=fr`, which a static host serves without
  a rewrite rule. The default language is the bare address, so there is one canonical
  URL. The address is kept in step so a copied link carries the language on screen.
  Switching is a fetch and a repaint; the panel the visitor had open stays open.
- **Everyone arrives in English.** The language is resolved from the URL, then from
  `localStorage` — a choice made in the address, then a choice made last visit — and
  otherwise it is `DEFAULT_LOCALE`. `navigator.languages` is deliberately not consulted:
  a browser's locale is set by the machine it was installed on, not by the person
  reading a portfolio, and letting it decide meant a first-time visitor could land in a
  language they never asked for on a URL that says nothing about it. If the site should
  stop remembering the choice too, drop the `localStorage` step in `pickLocale`.
- Note the global is `WORDS`, not `T`: the theme functions already bind
  `const T = TH()` for the palette, and a one-letter global would be shadowed there.
- **Everything shipped is left-to-right, and the stylesheet assumes it.** There is no
  `dir` handling and no RTL rules. A right-to-left language is not a row in the table:
  the panel's edge, the reticle's tag, the arrow rotations and the lightbox buttons all
  name a side literally, and the `.2em` tracking that gives the interface its register
  has to come off entirely for any script whose letters join — it is inserted *between*
  joined letters and pulls a word apart into its glyphs.

### One fact can live in four files

Because the same data is projected into the runtime JSON, the `<noscript>` mirror and
the JSON-LD, a single edit often has several landing sites. A link in
`site.config.json` also appears in `content.json`, in the `<noscript>` `<ul>`, and in
JSON-LD `sameAs`.

**Change the source, then run `npm run build`.** Hand-editing `content.json` or the
SEO regions works until the next build erases it. If you must hand-edit (e.g. to avoid
a build while `index.html` has uncommitted hand changes), update every copy —
`grep` for the old string first.

### The hero form

No 3D model is ever fetched. The shape is an icosphere whose vertices are displaced in
a vertex shader; every shape it can take is a radial function `r(direction)` in the
`SHAPES` array in `index.html`. Adding one is purely additive — the shuffle bag, the
idle warm-up and the `FORM` readout all read `SHAPES.length`.

Constraints that are easy to violate and hard to see:

- Fillet radii derive from `VSPACE`, the mean vertex spacing at the current `DETAIL`.
  A feature narrower than a couple of spacings does not render sharper, it renders as
  noise.
- A hard `max`/`min` union asks for a crease of zero radius that no mesh can draw.
  Use the `smin`/`smax` polynomial fillets, or size features so they provably cannot
  overlap.
- Parametrise falloffs by **angle**, not by the raw dot product — normalising the
  cosine piles the whole wall against the feature's rim.
- Each cached shape holds roughly 250 KB of vertex buffers at `DETAIL` 5.

Faceting can be measured objectively: build the mesh, orient each face normal outward
(the icosphere's winding is not consistent), and take the dihedral angle across every
shared edge. A plain sphere reads ~1.4°; shapes meant to look smooth should stay well
under ~30°.

### Device tiers

`reduce` / `coarse` / `lowEnd` are decided before the first frame from
`prefers-reduced-motion`, pointer type, core count, memory and the GPU string. They
pick `DETAIL` (3, 4 or 5) and the material stack — decisions that are made once at
construction and cannot be revisited. `cheap` is the runtime half: if FPS stays under
40 for two consecutive half-seconds after the intro, the pixel ratio and frame cap are
lowered. When in doubt the code chooses the cheap path.

## Authoring content

- **A project**: `projects/NN-category/slug/` containing `index.md` and images.
  Cover = the front-matter `cover:` if it matches a file, else `cover.*`, else the
  first image; the rest become the gallery in natural sort order. `## Overview` and
  `## Contribution` (aliases: brief/about, approach/process/role) become the two body
  sections.

  Front matter is `title`, `client` (or `clients` for more than one), `year`, `role`,
  an optional `link`, `tag`, `roles` — in that order, and nothing else. A project's
  `category:` and `order:` are read by nothing: works are grouped by the folder they
  sit in and sorted newest year first. `cover:` is only worth writing when the cover
  is *not* the file called `cover.*`. `label_overview` / `label_contribution` are only
  worth writing when a project wants a heading other than the default OVERVIEW /
  CONTRIBUTION — which lives in `STRINGS.info` in `index.html`, in one place, for all
  of them.

  `tag` is `DISCIPLINE / DETAIL` — two descriptors at most, and **no year**. It sits
  in the panel header, directly above the `YEAR` the panel prints from `year:`, and
  the grid card the visitor clicked printed that year too. A year in the tag is the
  same fact a third time, and one more copy to keep in step — it had already drifted
  once, saying 2022 over a project dated 2020.
- **A category**: `projects/NN-name/category.md` with `key`, `sub`, `kind`.
- **A client**: one image in `clients/`. The clients page is derived from projects that
  name a client — there is no second list. Projects marked `self_initiated` (or whose
  client is a stand-in like "Self-Initiated") are shown as work but never as clients.
- **A translation**: the same file with the language in its name — `index.fr.md`,
  `about.fr.md`, `category.fr.md`, and `about/<cv_filename>.fr.pdf` for the CV. Write only what
  changes; everything else falls back to the file it sits beside. `npm run build`
  reports how many documents each language has.

  An overlay replaces a key, so it has to name the *same* key. `client` and `clients`
  are two keys that both feed one deduped list: a base that says `client: Acme` and a
  translation that says `clients: [Acmé]` does not translate the name, it lists the
  company twice and relabels the field CLIENTS. Translate `client` with `client`.
- **A new language**: add it to `i18n.locales` in `site.config.json` (with a `labels`
  and `og_locale` entry), then add the same code to `LOCALES`, `LOCALE_LABEL`,
  `LOCALE_NAME` and `STRINGS` in `index.html`. It renders in the default language's
  words until translation files exist. A right-to-left language needs more than this —
  see the last point under **Two languages, one document**.

### The banner is composed, not shot

`tools/build-linkedin.mjs` photographs the real hero without a person present, and
it only finishes on a machine whose headless Chrome can actually draw. Here it
cannot: SwiftShader rasterises every frame of the morph on the CPU, the virtual
clock advances only when a frame is done, and the first pass runs past six minutes
without writing a file. The one banner it did produce was type on an empty field.

`tools/linkedin-studio.html` does the same job in the browser you are sitting at,
which has a GPU. It frames the live site in an iframe, hides the interface, and lays
the banner out around it — pick a shape by name, drag on it to turn it, then
CAPTURE and EXPORT PNG. The type is never drawn twice: the
exporter measures each line off the element beside it, so the PNG cannot drift from
the preview. `window.__banner` exposes `paint`, `state`, `hold`, `capture` and `scatter`, which is how
the page is checked and how a future headless run could drive it.

It has to be **served** — same origin is what lets the studio reach into the frame:

```bash
npm run studio   # http://localhost:3579/tools/linkedin-studio.html
```

The frame it renders is exactly 1584x396 at zoom 100%, so a screenshot cropped to
the blue guide is the same picture as the export. Turning TEXT, GRID, VIGNETTE and
RULERS off leaves only the forms, for cropping by hand.

It has a second format, **POST** (1200x627 landscape): the image for announcing the
site — a few forms scattered on the ground, the name and the address, nothing else.

The form is **posed, not caught**. At `?shot=1` the site exposes `window.__shot`
(defined next to `letGo` in `index.html`, and absent for every other visitor):
`hold(i)` raises a named shape and pins it standing, `still(true)` drops the idle
sway, the pointer lean and the lens so a pose stays where it was put,
`pose`/`setPose` read and write the turn and tilt, and `snap()` draws one frame with
no ground, backdrop or dot field and returns it as a canvas. That is why the renderer
takes `alpha: SHOT`. CAPTURE trims the snap to the form and lays it on the picture
as a draggable piece; every capture also lands in a tray shared by both formats, and
is kept in localStorage as WebP. Both formats — and `og.png`, and
`build-linkedin.mjs` — frame the picture with the site's edge rulers, not corner
brackets.

`?shot=1` is what makes any of it possible: the site’s renderer keeps
`preserveDrawingBuffer` off for everyone who came to look, because it costs a copy
of the frame buffer per frame — and with it off the canvas reads back as an empty
square. That is how every earlier attempt at this header failed.

## Invariants

- The email address is split into `user` / `domain` / `tld` in `site.config.json` and
  reassembled at runtime. It must never appear whole in any file the browser
  downloads — that includes the `<noscript>` mirror and the JSON-LD.
- **The CV PDF is named after the person, not after what it is.** The stem is
  `cv_filename` in `site.config.json` — `npm run cv` writes
  `about/<stem>.pdf` and `about/<stem>.<lang>.pdf`, and `build-content.mjs`
  looks up that same name (falling back to a bare `cv.pdf`, then to any single
  PDF in `about/`). It is what a visitor's browser saves the file as, which is
  the whole point: `cv.pdf` disappears into a downloads folder. Changing it
  moves the file and the old address stops resolving, so any link already handed
  out breaks.
- **The CV is one page, in every language.** French sets about a sixth longer than
  the same English sentence, so a translation that says nothing new can still spill a
  line onto a second sheet. `npm run cv` measures each rendered page in the same
  headless Chrome that prints it and, only when a language overflows, scales that one
  page down by the measured ratio; the printed PDF’s page count is what settles it.
  A language that fits is printed unscaled, and the run reports which is which.
- **The CV is read by an applicant-tracking system before a person**, so the template
  in `build-cv.mjs` holds to three rules that each broke parsing once. One column: a
  sidebar was read across, interleaved with the experience. No positioned elements:
  Chrome writes their text after everything in normal flow, and a relatively
  positioned `<li>` sent every bullet to the end of the file, cut off from its job.
  No `letter-spacing`: a parser guesses spaces from glyph gaps, so tracked capitals
  came out as `M U L T I - D I S C I P L I N A R Y`. Check a change with
  `pdftotext -enc UTF-8 -raw` (the order the text is written in) and `-layout`
  (the order a positional parser reconstructs).
- `og.png` must stay 1200×630. LinkedIn will not render a large card below 1200×627,
  and Telegram and WhatsApp centre-crop anything squarer.
- **Nothing in `.tools` may change width *during* a press.** The row takes its width
  from its contents and sits against the right edge, so a control that resizes drags its
  neighbours sideways by 36px on a desktop. The language buttons are 33px wide, so that
  is a lost click. On a phone the row is full-width, with the theme and language
  switches together at the left and the audio toggle held against the right edge by a
  margin — so there it grows into empty space and moves nobody.

  A width normally only changes as the *result* of a click, which is harmless. The
  audio label is the exception: the first pointerdown anywhere unlocks the audio and
  turns `AUDIO STANDBY` into `AUDIO ON` while the button is still held down, so the
  control being pressed slid away before the click was dispatched — the first attempt
  to change the language or the theme did nothing but start the sound, and the second
  worked. `#sound` therefore holds its width from that pointerdown until the frame after
  the pointer lifts. Note that reordering the row does not fix this and reserving width
  for the longest label makes the button permanently wider; neither was wanted.
- **A language is two edits, not one.** `i18n.locales` in `site.config.json` decides
  what the build writes and what the SEO declares; `LOCALES` in `index.html` decides
  what the switcher offers and which `content.<lang>.json` is ever fetched. Out of step,
  the build emits a file nothing asks for, or the switcher asks for a file that is not
  there.
- The code comments here carry the reasoning behind non-obvious choices and are part
  of the codebase's voice. Match their register — explain *why*, in prose, when a
  decision would otherwise look arbitrary.

## Notes

`tools/build-content.mjs` references `.github/workflows/deploy.yml` for CI, which is
not present in this working copy.
