#!/usr/bin/env python3
"""
Builds the viewer's data from a Lost City content folder.

Usage:
    python3 tools/build.py <path-to-content>

Example:
    python3 tools/build.py ~/Projects/git/lostcity-274/content

Writes:
    data/index.json     every loc, npc, obj and raw model, with IDs, names and model lists
    data/textures.json  average colour of each texture (textured faces are drawn in this colour)
    models/<name>.ob2   the raw model files, copied as-is (decoded in the browser)
"""

import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_pack(content, kind):
    """content/pack/<kind>.pack -> {name: id}"""
    ids = {}
    with open(os.path.join(content, 'pack', f'{kind}.pack'), encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if '=' not in line:
                continue
            num, name = line.split('=', 1)
            if num.isdigit():
                ids[name] = int(num)
    return ids


def config_files(content, ext):
    for dirpath, dirnames, filenames in os.walk(os.path.join(content, 'scripts')):
        # _unpack holds reference dumps of older revisions, not live config
        dirnames[:] = [d for d in dirnames if d != '_unpack']
        for name in filenames:
            if name.endswith(ext):
                yield os.path.join(dirpath, name)


def parse_configs(content, ext):
    """yields (debugname, {key: [values...]}, relative file path)"""
    for path in config_files(content, ext):
        current = None
        props = {}
        with open(path, encoding='utf-8', errors='replace') as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith('//'):
                    continue
                m = re.match(r'^\[(.+)\]$', line)
                if m:
                    if current is not None:
                        yield current, props, os.path.relpath(path, content)
                    current = m.group(1)
                    props = {}
                    continue
                if current is None or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                props.setdefault(key, []).append(value)
        if current is not None:
            yield current, props, os.path.relpath(path, content)


def first(props, key, default=None):
    v = props.get(key)
    return v[0] if v else default


def to_int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def rgb15_to_hsl16(rgb):
    """Config recolours are written as 15-bit RGB; models use 16-bit HSL.
    Same conversion the engine's packer does (src/util/ColorConversion.ts)."""
    r = ((rgb >> 10) & 0x1f) / 31.0
    g = ((rgb >> 5) & 0x1f) / 31.0
    b = (rgb & 0x1f) / 31.0
    lo, hi = min(r, g, b), max(r, g, b)
    h = s = 0.0
    l = (lo + hi) / 2.0
    if lo != hi:
        s = (hi - lo) / (hi + lo) if l < 0.5 else (hi - lo) / (2.0 - hi - lo)
        if r == hi:
            h = (g - b) / (hi - lo)
        elif g == hi:
            h = (b - r) / (hi - lo) + 2.0
        else:
            h = (r - g) / (hi - lo) + 4.0
    h /= 6.0
    hue = int(h * 256.0)
    sat = max(0, min(255, int(s * 256.0)))
    light = max(0, min(255, int(l * 256.0)))
    if light > 243:
        sat >>= 4
    elif light > 217:
        sat >>= 3
    elif light > 192:
        sat >>= 2
    elif light > 179:
        sat >>= 1
    return (((hue & 0xff) >> 2) << 10) + ((sat >> 5) << 7) + (light >> 1)


def recolours(props, prefix):
    """recol1s/recol1d ... -> [[src, dst], ...] as 16-bit HSL"""
    pairs = []
    for i in range(1, 11):
        s = to_int(first(props, f'{prefix}{i}s'))
        d = to_int(first(props, f'{prefix}{i}d'))
        if s is not None and d is not None:
            pairs.append([rgb15_to_hsl16(s), rgb15_to_hsl16(d)])
    return pairs


def raw_recolours(props):
    """the recol values exactly as written in the config file"""
    return [[to_int(first(props, f'recol{i}s')), to_int(first(props, f'recol{i}d'))]
            for i in range(1, 11) if first(props, f'recol{i}s') is not None and first(props, f'recol{i}d') is not None]


def retextures(props, tex_ids):
    pairs = []
    for i in range(1, 11):
        s = first(props, f'retex{i}s')
        d = first(props, f'retex{i}d')
        if s in tex_ids and d in tex_ids:
            pairs.append([tex_ids[s], tex_ids[d]])
    return pairs


def model_list(props, keys):
    names = []
    for key in keys:
        for value in props.get(key, []):
            name = value.split(',')[0].strip()
            if name and name != 'null':
                names.append(name)
    return names


def texture_colours(content, tex_ids):
    try:
        from PIL import Image
    except ImportError:
        print('Pillow not installed; textured faces will be grey (pip install pillow to fix)')
        return {}

    out = {}
    for name, tid in tex_ids.items():
        path = os.path.join(content, 'textures', f'{name}.png')
        if not os.path.exists(path):
            continue
        img = Image.open(path).convert('RGBA')
        r = g = b = n = 0
        px = img.tobytes()
        for i in range(0, len(px), 4):
            pr, pg, pb, pa = px[i], px[i + 1], px[i + 2], px[i + 3]
            if pa == 0 or (pr, pg, pb) == (255, 0, 255):
                continue
            r += pr
            g += pg
            b += pb
            n += 1
        if n:
            out[tid] = [r // n, g // n, b // n]
    return out


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)

    content = os.path.abspath(os.path.expanduser(sys.argv[1]))
    if not os.path.isdir(os.path.join(content, 'pack')):
        print(f'{content} does not look like a Lost City content folder (no pack/ inside)')
        sys.exit(1)

    model_ids = read_pack(content, 'model')
    tex_ids = read_pack(content, 'texture')

    # copy every .ob2 model, flattened by name
    models_out = os.path.join(ROOT, 'models')
    if os.path.isdir(models_out):
        shutil.rmtree(models_out)
    os.makedirs(models_out)

    available = set()
    for dirpath, _, filenames in os.walk(os.path.join(content, 'models')):
        for name in filenames:
            if name.endswith('.ob2'):
                src = os.path.join(dirpath, name)
                if os.path.getsize(src) == 0:
                    continue
                shutil.copyfile(src, os.path.join(models_out, name))
                available.add(name[:-4])

    entries = []

    def add(kind, debugname, ids, props, file, model_keys, scale):
        if debugname not in ids:
            return
        models = [m for m in model_list(props, model_keys) if m in available]
        entry = {
            't': kind,
            'id': ids[debugname],
            'n': debugname,
            'name': first(props, 'name', ''),
            'm': models,
            'f': file,
        }
        rc = recolours(props, 'recol')
        if rc:
            entry['rc'] = rc
            entry['rcs'] = raw_recolours(props)
        rt = retextures(props, tex_ids)
        if rt:
            entry['rt'] = rt
        if scale:
            entry['sc'] = scale
        if first(props, 'mirror') == 'yes':
            entry['mi'] = 1
        entries.append(entry)

    loc_ids = read_pack(content, 'loc')
    for debugname, props, file in parse_configs(content, '.loc'):
        scale = [to_int(first(props, k), 128) for k in ('resizex', 'resizey', 'resizez')]
        add('loc', debugname, loc_ids, props, file, ['model', 'model2', 'model3'], scale if scale != [128, 128, 128] else None)

    npc_ids = read_pack(content, 'npc')
    for debugname, props, file in parse_configs(content, '.npc'):
        h = to_int(first(props, 'resizeh'), 128)
        v = to_int(first(props, 'resizev'), 128)
        add('npc', debugname, npc_ids, props, file, [f'model{i}' for i in range(1, 13)], [h, v, h] if (h, v) != (128, 128) else None)

    obj_ids = read_pack(content, 'obj')
    for debugname, props, file in parse_configs(content, '.obj'):
        scale = [to_int(first(props, k), 128) for k in ('resizex', 'resizey', 'resizez')]
        add('obj', debugname, obj_ids, props, file, ['model'], scale if scale != [128, 128, 128] else None)

    for name, mid in model_ids.items():
        if name in available:
            entries.append({'t': 'model', 'id': mid, 'n': name, 'name': '', 'm': [name]})

    order = {'loc': 0, 'npc': 1, 'obj': 2, 'model': 3}
    entries.sort(key=lambda e: (order[e['t']], e['id']))

    data_out = os.path.join(ROOT, 'data')
    os.makedirs(data_out, exist_ok=True)
    with open(os.path.join(data_out, 'index.json'), 'w') as f:
        json.dump(entries, f, separators=(',', ':'))
    with open(os.path.join(data_out, 'textures.json'), 'w') as f:
        json.dump(texture_colours(content, tex_ids), f, separators=(',', ':'))

    counts = {k: sum(1 for e in entries if e['t'] == k) for k in order}
    print(f"{len(available)} model files copied")
    print(f"index: {counts['loc']} locs, {counts['npc']} npcs, {counts['obj']} objs, {counts['model']} raw models")


if __name__ == '__main__':
    main()
