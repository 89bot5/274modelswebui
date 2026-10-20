# 274 Model Viewer

A browser viewer for every object (loc), NPC, item (obj) and raw model in the Lost City
274 (November 2004) game data. Search by ID or name, click a row, and the model renders in
the box on the right: drag to rotate, scroll to zoom, right-drag to pan.

Links like `index.html#loc/2213` open a specific entry directly.

## Hosting

It's a plain static site with no build step and no server code. Clone it into your web root:

```bash
cd <webroot>/D
git clone https://github.com/89bot5/274modelswebui.git 274
```

Then open `https://<your-site>/D/274/`. To update later: `git pull` in that folder.

(Opening `index.html` straight from disk won't work, because browsers block `fetch()` on
`file://` pages. For a quick local look, run `python3 -m http.server` in this folder and open
http://localhost:8000.)

## Rebuilding the data

`data/` and `models/` are generated from a Lost City content folder. After you add or change
models, objects, NPCs or items in your content fork, regenerate them:

```bash
python3 tools/build.py ~/Projects/git/lostcity-274/content
```

Pillow (`pip install pillow`) is used to work out texture colours. Without it everything
still works, but textured faces are drawn grey.

## How it works

- `tools/build.py` reads the ID lists in `content/pack/*.pack`, the `.loc`, `.npc` and `.obj`
  configs (skipping `_unpack`), and copies every `.ob2` model file. It writes
  `data/index.json` and `data/textures.json`.
- `js/ob2.js` decodes `.ob2` models in the browser, ported from the Lost City client's
  `Model.ts`, and recreates the game's colour palette.
- `js/app.js` handles search and renders with three.js (`vendor/`, MIT licensed). Recolours,
  retextures, resizing and mirroring from the configs are applied, so a rune platebody shows
  up rune-coloured rather than in the base model's colours.

It's a simplified renderer: no animations, and textured faces use the texture's average
colour instead of the full texture.
