"""
Mycopunk data extractor.

Reads the installed game (Unity 6, Mono build) and produces:
  site/data/game.json   - gear, characters, upgrades (with hex patterns), localisation
  site/data/icons/*.png - upgrade / gear icons

Data sources inside the game:
  Mycopunk_Data/Managed/*.dll        - C# assemblies, used to generate Unity type trees
                                       (asset files ship without type trees)
  Mycopunk_Data/resources.assets     - GearInfo, GenericGunUpgrade, ... ScriptableObjects
  Mycopunk_Data/sharedassets0.assets - characters, character upgrades, grid profiles
  TextAsset "TextBlocks"             - localisation CSV (key, meta, en, fr, de, es, ru, pt, zh, zh-tw, ja, ko)

Usage:
  python extractor/extract.py --game "C:/Program Files (x86)/Steam/steamapps/common/Mycopunk"
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict

import UnityPy
import UnityPy.helpers.TypeTreeHelper as TTH
from UnityPy.helpers.TypeTreeNode import TypeTreeNode
from TypeTreeGeneratorAPI import TypeTreeGenerator

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from statmap import build_stat_map  # noqa: E402

# The C accelerated reader does not route [SerializeReference] lookups through
# get_ref_type_node, so force the pure Python reader (fast enough for ~1000 objects).
TTH.read_typetree_boost = None

LANG_COLUMNS = {"en": 2, "fr": 3, "de": 4, "es": 5, "ru": 6, "pt": 7, "zh": 8, "zhtw": 9, "ja": 10, "ko": 11}
EXPORT_LANGS = ("en", "ru")

RARITIES = [  # enum Rarity
    {"id": 0, "key": "standard", "color": "#3CF673"},
    {"id": 1, "key": "rare", "color": "#58CBFF"},
    {"id": 2, "key": "epic", "color": "#F164FF"},
    {"id": 3, "key": "exotic", "color": "#FFAD3B"},
    {"id": 4, "key": "oddity", "color": "#FF3134"},
    {"id": 5, "key": "contraband", "color": "#734CFF"},
]
EFFECT_TYPES = {0: "normal", 1: "fire", 2: "shock", 3: "acid", 4: "decay", 5: "immunity",
                6: "yellowresource", 7: "rot", 8: "bees", 9: "water", 10: "cryo"}
UPGRADE_FLAGS = {  # enum Upgrade.UpgradeFlags
    2: "SkillTreeUpgrade", 4: "ApplyStatUpgrades", 8: "CanStack", 16: "ExcludeFromWorldPool",
    32: "NoRandom", 64: "Coop", 128: "CraftLocked", 256: "DisableScrap", 512: "CantCraftBeforeCollected",
    1024: "GearDupeProtection", 2048: "NoScrapRewards", 4096: "AllowCraftingWhenNotWorldPool",
    8192: "CanTurbocharge", 16384: "CanStackInMission", 32768: "OnlyInOuroboros",
    65536: "CanCleanseBeforeDiscovered", 131072: "CantDropInOuroBeforeDiscovered", 262144: "CantBoost",
    524288: "IsSpatial", 1048576: "CantRollAtLarry",
}
COLLECTION_SOURCES = {0: "WorldPool", 1: "None", 2: "UpgradeTree", 3: "DropsFromSource", 4: "HiddenAlways",
                      5: "HiddenIfNotOwned", 6: "Beta", 7: "LevelUp", 8: "Resources"}
MB_HEADER = {"m_GameObject", "m_Enabled", "m_Script", "m_Name"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class TypeTrees:
    """Generates Unity type trees from the game's managed assemblies."""

    def __init__(self, managed_dir: str, unity_version: str):
        self.gen = TypeTreeGenerator(unity_version)
        for f in sorted(os.listdir(managed_dir)):
            if f.endswith(".dll"):
                try:
                    with open(os.path.join(managed_dir, f), "rb") as fh:
                        self.gen.load_dll(fh.read())
                except Exception:
                    pass
        self.cache: dict = {}

    def nodes(self, asm: str, full_name: str, plain: bool = False):
        key = (asm, full_name, plain)
        if key not in self.cache:
            node = None
            try:
                raw = json.loads(self.gen.get_nodes_as_json(asm, full_name))
                if plain:
                    # The generator always prepends the MonoBehaviour header; plain
                    # [Serializable] classes (SerializeReference payloads) don't have it.
                    out, skip = [raw[0]], False
                    for n in raw[1:]:
                        if n["m_Level"] == 1:
                            skip = n["m_Name"] in MB_HEADER
                        if not skip:
                            out.append(n)
                    raw = out
                node = TypeTreeNode.from_list(raw)
            except Exception as e:  # noqa: BLE001
                log(f"  ! no type tree for {asm}:{full_name}: {e}")
            self.cache[key] = node
        return self.cache[key]


def install_ref_resolver(tt: TypeTrees):
    def resolve(ref_object, assetfile):
        typ = ref_object["type"]
        get = (lambda k: typ[k]) if isinstance(typ, dict) else (lambda k: getattr(typ, k))
        cls, ns, asm = get("class"), get("ns"), get("asm")
        if not cls:
            return None
        node = tt.nodes(asm.replace(".dll", ""), f"{ns}.{cls}" if ns else cls, plain=True)
        if node is None:
            raise ValueError(f"no type tree for referenced type {cls}")
        return node

    TTH.get_ref_type_node = resolve


def clean(v):
    """Make typetree output JSON friendly and compact."""
    if isinstance(v, float):
        r = round(v, 4)
        return int(r) if r == int(r) and abs(r) < 1e9 else r
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    return v


class Extractor:
    def __init__(self, game_dir: str, out_dir: str, include_ouroboros: bool = False):
        self.include_ouroboros = include_ouroboros
        self.game_dir = game_dir
        self.data_dir = os.path.join(game_dir, "Mycopunk_Data")
        self.out_dir = out_dir
        self.icons_dir = os.path.join(out_dir, "icons")
        os.makedirs(self.icons_dir, exist_ok=True)

        files = ["globalgamemanagers.assets", "resources.assets"]
        files += sorted(f for f in os.listdir(self.data_dir) if re.fullmatch(r"sharedassets\d+\.assets", f))
        log(f"Loading {len(files)} asset files ...")
        self.env = UnityPy.load(*[os.path.join(self.data_dir, f) for f in files])
        self.files = {os.path.basename(name).lower(): f for name, f in self.env.files.items()}
        first = next(iter(self.env.files.values()))
        self.unity_version = first.unity_version
        log(f"Unity {self.unity_version}")
        self.tt = TypeTrees(os.path.join(self.data_dir, "Managed"), self.unity_version)
        install_ref_resolver(self.tt)

        self.by_key: dict = {}  # (file, pathID) -> ObjectReader
        self.scripts: dict = {}  # (file, pathID) -> (asm, fullname, classname)
        self.typed: dict = defaultdict(list)  # classname -> [(key, data)]
        self.parsed: dict = {}

    # ---------- object access ----------
    def key_of(self, obj):
        return (os.path.basename(obj.assets_file.name).lower(), obj.path_id)

    def resolve(self, src_file: str, pptr: dict):
        pid = pptr.get("m_PathID", 0)
        if not pid:
            return None
        fid = pptr.get("m_FileID", 0)
        if fid == 0:
            return (src_file, pid)
        ext = self.files[src_file].externals[fid - 1].path
        return (os.path.basename(ext).lower(), pid)

    def index(self):
        log("Indexing MonoBehaviours ...")
        for obj in self.env.objects:
            k = self.key_of(obj)
            self.by_key[k] = obj
            if obj.type.name != "MonoBehaviour":
                continue
            try:
                mb = obj.read(check_read=False)
                sc = mb.m_Script.read()
            except Exception:
                continue
            full = f"{sc.m_Namespace}.{sc.m_ClassName}" if sc.m_Namespace else sc.m_ClassName
            self.scripts[k] = (sc.m_AssemblyName.replace(".dll", ""), full, sc.m_ClassName)

    def parse(self, k):
        if k in self.parsed:
            return self.parsed[k]
        obj = self.by_key.get(k)
        info = self.scripts.get(k)
        data = None
        if obj is not None and info is not None:
            node = self.tt.nodes(info[0], info[1])
            if node is not None:
                try:
                    data = obj.read_typetree(node, check_read=False)
                except Exception as e:  # noqa: BLE001
                    log(f"  ! failed to read {info[2]} {k}: {e}")
        self.parsed[k] = data
        return data

    def of_class(self, *names):
        for k, info in self.scripts.items():
            if info[2] in names:
                d = self.parse(k)
                if d is not None:
                    yield k, d

    # ---------- localisation ----------
    def load_text(self):
        for obj in self.env.objects:
            if obj.type.name == "TextAsset":
                ta = obj.read()
                if ta.m_Name == "TextBlocks":
                    s = ta.m_Script
                    if isinstance(s, (bytes, bytearray)):
                        s = s.decode("utf-8", "replace")
                    s = s.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
                    self.text = {}
                    self.text_meta = {}
                    for row in csv.reader(io.StringIO(s)):
                        if row and row[0]:
                            self.text[row[0]] = row
                    log(f"Localisation: {len(self.text)} keys")
                    return
        raise RuntimeError("TextBlocks not found")

    def loc(self, key):
        row = self.text.get(key) if key else None
        if not row:
            return None
        out = {}
        for lang in EXPORT_LANGS:
            col = LANG_COLUMNS[lang]
            if col < len(row) and row[col].strip():
                out[lang] = row[col]
        return out or None

    def keywords(self):
        """Rows like `fire,"keyword:1,color:#FF642A","fire, ignite, ..."` used to colour descriptions."""
        out = []
        for key, row in self.text.items():
            meta = row[1] if len(row) > 1 else ""
            if "keyword" not in meta:
                continue
            m = re.search(r"color:\s*(#[0-9A-Fa-f]{6})", meta)
            words = {}
            for lang in EXPORT_LANGS:
                col = LANG_COLUMNS[lang]
                if col < len(row):
                    words[lang] = [w.strip() for w in row[col].split(",") if w.strip()]
            out.append({"key": key, "color": m.group(1) if m else None, "words": words})
        return out

    # ---------- icons ----------
    def export_icon(self, src_file, pptr):
        k = self.resolve(src_file, pptr) if pptr else None
        if not k:
            return None
        name = f"{k[0].replace('.assets', '')}_{k[1]}.png"
        path = os.path.join(self.icons_dir, name)
        if os.path.exists(path):
            return name
        obj = self.by_key.get(k)
        if obj is None or obj.type.name not in ("Sprite", "Texture2D"):
            return None
        try:
            img = obj.read().image
            if img.width > 256 or img.height > 256:
                img.thumbnail((256, 256))
            img.save(path)
            return name
        except Exception as e:  # noqa: BLE001
            log(f"  ! icon {k}: {e}")
            return None

    # ---------- domain ----------
    @staticmethod
    def pattern(hexmap):
        cells = []
        for y, row in enumerate(hexmap.get("nodes", [])):
            for x, n in enumerate(row.get("nodes", [])):
                if n.get("enabled"):
                    cells.append([x, y, n.get("connections", 0)])
        return {"w": hexmap.get("width", 0), "h": hexmap.get("height", 0), "cells": cells}

    def upgrade(self, k, d):
        src = k[0]
        name_key = d.get("_name") or d.get("m_Name")
        desc_key = d.get("_description") or ""
        desc = self.loc(desc_key) if desc_key else None
        for suffix in ("_1", "D"):  # both conventions exist in TextBlocks
            if not desc:
                desc = self.loc(f"{name_key}{suffix}")
        flags = d.get("<Flags>k__BackingField", 0) & 0xFFFFFFFF
        props = []
        for ref in d.get("references", {}).get("RefIds", []):
            cls = ref["type"]["class"]
            if not cls:
                continue
            props.append({"type": re.sub(r"^UpgradeProperty_", "", cls), "data": clean(ref.get("data", {}))})
        alt_patterns = [self.pattern(p["data"]["pattern"]) for p in d.get("references", {}).get("RefIds", [])
                        if p["type"]["class"] == "UpgradeProperty_Pattern" and "pattern" in p.get("data", {})]
        limit = self.resolve(src, d.get("upgradeLimitProvider", {}))
        return {
            "id": d.get("id"),
            "key": name_key,
            "asset": d.get("m_Name"),
            "class": self.scripts[k][2],
            "name": self.loc(name_key) or {"en": name_key},
            "desc": desc,
            "rarity": d.get("<Rarity>k__BackingField", 0),
            "flags": [n for b, n in UPGRADE_FLAGS.items() if flags & b],
            "effect": EFFECT_TYPES.get(d.get("effectType", 0), str(d.get("effectType"))),
            "source": COLLECTION_SOURCES.get(d.get("collectionSource", 0), str(d.get("collectionSource"))),
            "priority": d.get("<Priority>k__BackingField", 0),
            "limit": f"{limit[0]}:{limit[1]}" if limit else None,
            "icon": self.export_icon(src, d.get("icon")),
            "pattern": self.pattern(d.get("pattern", {})),
            "altPatterns": alt_patterns,
            "props": props,
        }

    def stat_labels(self, upgrades):
        """Map every "<PropertyType>.<field>" used by the exported upgrades to the game's own
        label (TextBlocks key) and display hints, and maintain the manual overrides file."""
        dll = os.path.join(self.data_dir, "Managed", "Assembly-CSharp.dll")
        smap = build_stat_map(dll)
        labels = {}
        used = Counter()
        for u in upgrades.values():
            for p in u["props"]:
                for f in p["data"]:
                    used[f"{p['type']}.{f}"] += 1
        mapped = 0
        for path in sorted(used):
            ptype, field = path.split(".", 1)
            hit = next((s for s in smap.get(ptype, []) if s["field"] == field), None)
            entry = {"key": None, "label": None, "multiplier": False, "inverse": False, "patternScaled": False}
            if hit:
                entry.update({k: hit[k] for k in ("key", "multiplier", "inverse", "patternScaled")})
                entry["label"] = self.loc(hit["key"]) if hit["key"] else None
                if entry["label"]:
                    mapped += 1
            labels[path] = entry
        log(f"Stat labels: {mapped}/{len(labels)} fields mapped to game text")

        # Overrides file: created once, then only extended with new paths (values are never touched).
        ov_path = os.path.join(self.out_dir, "stats.overrides.json")
        ov = {}
        if os.path.exists(ov_path):
            with open(ov_path, encoding="utf-8") as fh:
                ov = json.load(fh)
        ov.setdefault("_readme", (
            "Manual stat labels. Key = '<PropertyType>.<field>' (see game.json -> statLabels). "
            "Fill 'en'/'ru' to replace the label shown on the site; 'format' may be "
            "'percent' (value x100 %), 'multiplier' (x1.05 -> +5%), 'seconds', 'number' or 'hidden'. "
            "Empty strings mean 'use the game label / auto label'. This file is never overwritten by the extractor."))
        fields = ov.setdefault("fields", {})
        for path, e in labels.items():
            entry = fields.setdefault(path, {"en": "", "ru": "", "format": ""})
            # informational only, refreshed on every run; user values (en/ru/format) are preserved
            entry["_game"] = " / ".join(filter(None, [(e["label"] or {}).get(x, "") for x in ("en", "ru")]))
            entry["_mult"] = e["multiplier"]
        with open(ov_path, "w", encoding="utf-8") as fh:
            json.dump(ov, fh, ensure_ascii=False, indent=1)
        return labels

    def run(self):
        t0 = time.time()
        self.index()
        self.load_text()

        # grids
        grid_profiles = {}
        grid_keys = {}
        for k, d in self.of_class("GridProfile"):
            grid_profiles[d["m_Name"]] = [{"level": g["level"], "w": g["width"], "h": g["height"]}
                                          for g in d.get("gridSizes", [])]
            grid_keys[k] = d["m_Name"]

        # upgrades: every ScriptableObject that has a hex pattern (except cosmetic skins)
        upgrades = {}
        upgrade_key_to_id = {}
        skipped = Counter()
        for k, info in self.scripts.items():
            cls = info[2]
            if cls == "SkinUpgrade" or not cls.endswith("Upgrade"):
                continue
            d = self.parse(k)
            if d is None or "pattern" not in d:
                skipped[cls] += 1
                continue
            u = self.upgrade(k, d)
            uid = str(u["id"])
            upgrades[uid] = u
            upgrade_key_to_id[k] = uid
        log(f"Upgrades: {len(upgrades)} (skipped {dict(skipped)})")

        # Ouroboros-only upgrades (UpgradeFlags.OnlyInOuroboros) use different grid rules -> excluded.
        ouro = {uid for uid, u in upgrades.items() if "OnlyInOuroboros" in u["flags"]}
        if not self.include_ouroboros:
            for uid in ouro:
                upgrades.pop(uid)
            log(f"Excluded {len(ouro)} Ouroboros-only upgrades")
        for u in upgrades.values():
            u["role"] = "normal"
            if any(p["type"] == "GrowGrid" for p in u["props"]):
                # UpgradeProperty_GrowGrid: +1 column or +1 row, chosen by the instance seed (AffectsColumn)
                u["role"] = "gridExpander"

        # characters: Character.DefaultUpgrade is the innate ability (shown in character select,
        # applied by Character.Setup) - it is NOT placed on the upgrade grid.
        char_info = {}
        for k, d in self.of_class("Character"):
            info_k = self.resolve(k[0], d.get("<Info>k__BackingField", {}))
            if info_k and d.get("isPlayable", 1):
                ab = self.resolve(k[0], d.get("DefaultUpgrade", {}))
                ab_id = upgrade_key_to_id.get(ab)
                if ab_id in upgrades:
                    upgrades[ab_id]["role"] = "ability"
                char_info[info_k] = {"ability": ab_id}

        gears = []
        for k, d in self.of_class("GearInfo"):
            ups = []
            for p in d.get("upgrades", []):
                uk = self.resolve(k[0], p)
                if upgrade_key_to_id.get(uk) in upgrades:
                    ups.append(upgrade_key_to_id[uk])
            grid = grid_keys.get(self.resolve(k[0], d.get("grid", {})) or ("", 0))
            if not grid:
                continue
            key = d.get("_name") or d["m_Name"]
            if k in char_info:
                category = "character"
            elif key == "player":
                category = "global"
            elif not ups:
                continue
            elif grid == "HeavyGridProfile":
                category = "heavy"
            elif "grenade" in key.lower() or key.lower() == "photondisc":
                category = "throwable"
            elif grid == "BrokenFrameGrid":
                category = "special"
            else:
                category = "primary"
            for uid in ups:
                upgrades[uid].setdefault("gears", []).append(str(d.get("<ID>k__BackingField")))
            color = None
            cp = d.get("colorProfile", {}).get("A")
            if cp:
                color = "#%02X%02X%02X" % tuple(int(max(0, min(1, cp[c])) * 255) for c in "rgb")
            gears.append({
                "id": str(d.get("<ID>k__BackingField")),
                "key": key,
                "asset": d["m_Name"],
                "category": category,
                "name": self.loc(key) or {"en": key},
                "icon": self.export_icon(k[0], d.get("<Icon>k__BackingField")),
                "grid": grid,
                "color": color,
                "ability": char_info.get(k, {}).get("ability"),
                "upgrades": ups,
            })
        order = {"character": 0, "primary": 1, "heavy": 2, "throwable": 3, "special": 4, "global": 5}
        gears.sort(key=lambda g: (order[g["category"]], (g["name"].get("en") or g["key"]).lower()))
        log(f"Gear: {len(gears)}")

        # Upgrades not listed in any GearInfo (grid expanders GridGrow / GridGrowC, character abilities)
        # are kept with an empty "gears" list; how expanders are assigned in-game is not encoded in data.
        for u in upgrades.values():
            u.setdefault("gears", [])

        stat_labels = self.stat_labels(upgrades)

        limits = {}
        for k, d in self.of_class("UpgradeLimitProvider"):
            limits[f"{k[0]}:{k[1]}"] = clean({x: v for x, v in d.items() if x not in MB_HEADER})

        # Rarity colours + rarity patterns from the Global ScriptableObject (Global.Rarities / RarityPatterns);
        # RARITIES above is only a fallback if Global cannot be read.
        def hexcolor(c):
            return "#%02X%02X%02X" % tuple(round(max(0.0, min(1.0, c[k])) * 255) for k in "rgb")

        rarities = [dict(r, name=self.loc(r["key"]) or {"en": r["key"].title()}) for r in RARITIES]
        rarity_patterns = []
        for _, g in self.of_class("Global"):
            for i, rd in enumerate(g.get("Rarities", [])):
                if i < len(rarities) and rd.get("color"):
                    rarities[i]["color"] = hexcolor(rd["color"])
                    rarities[i]["background"] = hexcolor(rd["backgroundColor"])
                    rarities[i]["colorSource"] = "Global.Rarities"
            rarity_patterns = [self.pattern(p) for p in g.get("RarityPatterns", [])]
            break
        effects = {v: (self.loc(v) or {"en": v.title()}) for v in EFFECT_TYPES.values()}
        ui = {k: self.loc(k) for k in ("upgrade", "upgrades", "Heavy", "normal") if self.loc(k)}

        version = None
        try:
            with open(os.path.join(self.data_dir, "app.info"), encoding="utf-8") as fh:
                version = " ".join(fh.read().split())
        except OSError:
            pass

        out = {
            "meta": {
                "game": "Mycopunk",
                "appInfo": version,
                "unity": self.unity_version,
                "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "langs": list(EXPORT_LANGS),
                "hex": {
                    "layout": "odd-q",
                    "note": "nodes[y][x]; odd columns shifted down by half a cell. "
                            "Connection bits: 1=N 2=NE 4=SE 8=S 16=SW 32=NW. "
                            "Rotation step = 60deg in cube coords (x,y,z)->(-y,-z,-x).",
                },
            },
            "rarities": rarities,
            # Global.RarityPatterns: patterns used for all upgrades while "Handheld Pocket Universe" (Cells) is active
            "rarityPatterns": rarity_patterns,
            "effects": effects,
            "keywords": self.keywords(),
            "gridProfiles": grid_profiles,
            "limits": limits,
            "gears": gears,
            "upgrades": upgrades,
            "statLabels": stat_labels,
            "ui": ui,
        }
        path = os.path.join(self.out_dir, "game.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
        log(f"Wrote {path} ({os.path.getsize(path) // 1024} KB) in {time.time() - t0:.1f}s")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", default=r"C:\Program Files (x86)\Steam\steamapps\common\Mycopunk")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site", "public", "data"))
    ap.add_argument("--include-ouroboros", action="store_true", help="keep OnlyInOuroboros upgrades")
    a = ap.parse_args()
    Extractor(a.game, os.path.abspath(a.out), a.include_ouroboros).run()


if __name__ == "__main__":
    main()
