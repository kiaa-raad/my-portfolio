# model/

`logo.glb` is the form the site loads with. That filename is fixed — it is
the first thing every visitor sees, so it never changes and is never chosen
at random.

Every other `.glb` (or `.gltf`) in this folder is a form the logo can turn
into. Names do not matter and neither does the count:

    model/
      logo.glb        <- always on load. Keep this name.
      knot.glb        <- picked at random on a tap
      spiral.glb
      whatever-you-like.glb

`tools/build-content.mjs` scans this folder and writes the list into
`content.json`, and CI runs it on every push — so adding a form is: drop the
file in, commit, done. Nothing in `index.html` needs editing.

## What triggers a morph

- A tap or click on the form itself
- Clicking a discipline chip (LOGOS, POSTERS, XR, MOTION)

Each morph goes to a form chosen at random from the others — never to the one
already standing, so a tap always visibly changes something. With only
`logo.glb` present, the form comes apart and reassembles into itself, exactly
as before.

## Preparing a file

- One shape, closed and reasonably clean. Every form is auto-centred and
  scaled to the same height, so proportions carry over and morphs never jump.
- Keep it light: roughly 20k–150k triangles. All of them are held in memory.
- Materials, textures, cameras and lights are discarded — only the geometry
  is used. The site's own materials are applied to it.
- Export as `.glb` (binary), Y-up, from Blender's default glTF exporter.

## Serving without the build script

If you are serving this folder somewhere that does not run
`node tools/build-content.mjs`, list the extras by hand in `model/models.json`:

    ["knot.glb", "spiral.glb"]

`content.json` takes priority; this file is only the fallback.
