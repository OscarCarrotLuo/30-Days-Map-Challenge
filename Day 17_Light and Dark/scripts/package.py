"""Prepare small globe textures and the self-contained edition. Requires Pillow."""
import base64
import json
import re
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def inline(path, mime):
    return "data:" + mime + ";base64," + base64.b64encode((ROOT / path).read_bytes()).decode()


def globe_textures():
    textures = {}
    for body in ("earth", "moon"):
        source = Image.open(ROOT / "assets" / (body + ".webp"))
        gray = source.convert("L").resize((360, 180), Image.Resampling.LANCZOS)
        textures[body] = base64.b64encode(gray.tobytes()).decode()
    (ROOT / "assets/globes.js").write_text("window.globeTextures=" + json.dumps(textures) + ";\n")


def standalone():
    html = (ROOT / "index.html").read_text()
    css = (ROOT / "sheet.css").read_text()
    css = re.sub(r'url\("(assets/[^"]+\.ttf)"\)', lambda m: 'url("' + inline(m[1], "font/ttf") + '")', css)
    html = html.replace('<link rel="stylesheet" href="sheet.css">', "<style>\n" + css + "\n</style>")
    scripts = re.findall(r'<script defer src="([^"]+)"></script>', html)
    html = re.sub(r'  <script defer src="[^"]+"></script>\n', "", html)
    html = re.sub(r'src="(assets/[^"]+\.webp)"', lambda m: 'src="' + inline(m[1], "image/webp") + '"', html)
    license_text = (ROOT / "assets/fonts/barlow-license.txt").read_text()
    embedded = '<script type="text/plain" id="font-license">' + license_text + "</script>\n"
    embedded += "".join("<script>\n" + (ROOT / path).read_text() + "\n</script>\n" for path in scripts)
    (ROOT / "Light and Dark_Oscar Luo.html").write_text(html.replace("</body>", embedded + "</body>"))


if __name__ == "__main__":
    globe_textures()
    standalone()
