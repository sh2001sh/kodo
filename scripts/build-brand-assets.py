"""Export Kodo's editable SVG masters to app, website and terminal assets.

Run with Python 3, Pillow and CairoSVG: python scripts/build-brand-assets.py
The original brand board is a visual reference; the SVG masters are redrawn paths.
"""

from copy import deepcopy
from io import BytesIO
from pathlib import Path
import json
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile, ZIP_DEFLATED

import cairosvg
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "brand"
INK, GRAPHITE, SNOW = "#0B0E12", "#687280", "#EAECEF"
SVG = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG)


def svg(viewbox, title, attributes=None):
    node = ET.Element(f"{{{SVG}}}svg", {
        "viewBox": viewbox, "role": "img", "aria-labelledby": "title",
        **(attributes or {}),
    })
    ET.SubElement(node, f"{{{SVG}}}title", {"id": "title"}).text = title
    return node


def paths_from(source, parent, transform=None):
    master = ET.parse(BRAND / source).getroot()
    attributes = {key: value for key, value in master.attrib.items()
                  if key in ("fill", "stroke", "stroke-width", "stroke-linejoin")}
    if transform:
        attributes["transform"] = transform
    group = ET.SubElement(parent, f"{{{SVG}}}g", attributes)
    for child in master:
        if child.tag.endswith("}path"):
            group.append(deepcopy(child))


def write_svg(relative, node):
    target = BRAND / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(ET.tostring(node, encoding="unicode") + "\n", encoding="utf-8")
    return target


def raster(source, width, height=None):
    png = cairosvg.svg2png(url=str(source), output_width=width, output_height=height)
    return Image.open(BytesIO(png)).convert("RGBA")


def export():
    for folder in ("icons", "png"):
        (BRAND / folder).mkdir(exist_ok=True)
    for variant, color in (("", "currentColor"), ("-dark", INK), ("-light", SNOW)):
        lockup = svg("0 0 512 128", "Kodo", {"color": color})
        paths_from("kodo-mark.svg", lockup, "translate(8 8)")
        paths_from("kodo-wordmark.svg", lockup, "translate(190 30)")
        lockup_file = write_svg(f"kodo-logo{variant}.svg", lockup)
        if variant:
            raster(lockup_file, 2048).save(BRAND / "png" / f"kodo-logo{variant}.png")
            mark = svg("-8 -16 144 144", "Kodo", {"color": color})
            paths_from("kodo-mark.svg", mark)
            mark_file = write_svg(f"kodo-mark{variant}.svg", mark)
            raster(mark_file, 1024).save(BRAND / "png" / f"kodo-mark{variant}.png")

    app = svg("0 0 1024 1024", "Kodo", {"color": SNOW})
    ET.SubElement(app, f"{{{SVG}}}rect", {"width": "1024", "height": "1024", "fill": INK})
    paths_from("kodo-mark.svg", app, "translate(208 246) scale(4.75)")
    app_file = write_svg("icons/kodo-app.svg", app)
    icon = raster(app_file, 1024).convert("RGB")
    icon.save(BRAND / "icons" / "kodo-app-1024.png")
    for size in (16, 32, 48, 64, 128, 180, 192, 256, 512):
        raster(app_file, size).convert("RGB").save(BRAND / "icons" / f"kodo-app-{size}.png")
    icon.save(BRAND / "icons" / "favicon.ico", sizes=[(s, s) for s in (16, 32, 48, 64, 128, 256)])
    icon.save(BRAND / "icons" / "kodo-app.icns", format="ICNS")
    manifest = {
        "name": "Kodo", "short_name": "Kodo", "display": "standalone",
        "background_color": INK, "theme_color": INK,
        "icons": [{"src": f"./kodo-app-{s}.png", "sizes": f"{s}x{s}", "type": "image/png", "purpose": "any maskable"}
                  for s in (192, 512)],
    }
    (BRAND / "icons" / "site.webmanifest").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Braille's 2x4 dots retain far more of the curved negative space than
    # six rows of solid blocks. Both sizes keep the SVG's physical aspect.
    def terminal_mark(columns, rows):
        alpha = raster(BRAND / "kodo-mark.svg", columns * 8, rows * 16).getchannel("A")
        alpha = alpha.resize((columns * 2, rows * 4), Image.Resampling.BOX)
        lines = []
        dots = ((0, 0, 0), (0, 1, 1), (0, 2, 2), (1, 0, 3), (1, 1, 4), (1, 2, 5), (0, 3, 6), (1, 3, 7))
        for y in range(rows):
            line = ""
            for x in range(columns):
                mask = sum(1 << bit for dx, dy, bit in dots if alpha.getpixel((x * 2 + dx, y * 4 + dy)) >= 128)
                line += chr(0x2800 + mask) if mask else " "
            lines.append(line)
        return lines
    lines = terminal_mark(32, 14)
    compact_lines = terminal_mark(16, 7)
    module = "/** Generated from brand/kodo-mark.svg by scripts/build-brand-assets.py. */\n"
    module += "export const KODO_MARK_LINES: readonly string[] = " + json.dumps(lines, ensure_ascii=False, indent=2) + ";\n\n"
    module += "export const KODO_MARK_COMPACT_LINES: readonly string[] = " + json.dumps(compact_lines, ensure_ascii=False, indent=2) + ";\n\n"
    module += "export const KODO_BRAND = " + json.dumps({
        "name": "Kodo", "tagline": "Know · Organize · Do", "promise": "理解目标，组织协作，执行交付。",
        "ink": INK, "graphite": GRAPHITE, "snow": SNOW,
    }, ensure_ascii=False, indent=2) + " as const;\n"
    (ROOT / "src" / "tui" / "brand.ts").write_text(module, encoding="utf-8")
    preview(icon)
    assets = [BRAND / "README.md", BRAND / "preview.png", *BRAND.glob("kodo-*.svg"),
              *(BRAND / "png").iterdir(), *(BRAND / "icons").iterdir()]
    with ZipFile(BRAND / "kodo-brand-assets.zip", "w", ZIP_DEFLATED) as archive:
        for asset in sorted(assets):
            archive.write(asset, asset.relative_to(BRAND).as_posix())
    print("Brand assets exported: SVG, transparent PNG, app PNG, ICO, ICNS, web manifest and terminal mark.")
    print("\n".join(lines))


def preview(icon):
    """Contact sheet for inspecting both contrast variants and icon silhouettes."""
    canvas = Image.new("RGB", (1440, 1000), INK)
    draw = ImageDraw.Draw(canvas)
    font_path = Path("C:/Windows/Fonts/segoeui.ttf")
    label = ImageFont.truetype(str(font_path), 18) if font_path.exists() else ImageFont.load_default()
    large = ImageFont.truetype(str(font_path), 24) if font_path.exists() else label
    draw.text((64, 40), "KODO / BRAND ASSETS", font=label, fill=GRAPHITE)
    light_logo = raster(BRAND / "kodo-logo-light.svg", 780)
    canvas.paste(light_logo, (56, 105), light_logo)
    draw.text((346, 306), "Know · Organize · Do", font=large, fill=SNOW)
    draw.rectangle((0, 400, 935, 710), fill=SNOW)
    dark_logo = raster(BRAND / "kodo-logo-dark.svg", 690)
    canvas.paste(dark_logo, (70, 460), dark_logo)
    canvas.paste(icon.resize((300, 300), Image.Resampling.LANCZOS), (1040, 110))
    draw.text((1050, 435), "APP / 1024 px", font=label, fill=GRAPHITE)
    for size, x in ((128, 1050), (64, 1220), (32, 1320)):
        canvas.paste(icon.resize((size, size), Image.Resampling.LANCZOS), (x, 518))
        draw.text((x, 670), str(size), font=label, fill=GRAPHITE)
    for color, name, x in ((INK, "INK  #0B0E12", 64), (GRAPHITE, "GRAPHITE  #687280", 500), (SNOW, "SNOW  #EAECEF", 1000)):
        draw.rectangle((x, 800, x + 48, 848), fill=color, outline=GRAPHITE)
        draw.text((x + 65, 811), name, font=label, fill=SNOW)
    draw.text((64, 925), "SVG masters / Transparent PNG / App icons / Terminal mark", font=large, fill=GRAPHITE)
    canvas.save(BRAND / "preview.png")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    export()
