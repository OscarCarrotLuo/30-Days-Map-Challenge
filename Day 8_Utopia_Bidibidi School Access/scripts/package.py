"""Bundle Barlow, the digitized source, and the interactive drawing for offline use."""
import base64
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "A School Close to Home_Oscar Luo.html"


def embedded_font(match):
    path = ROOT / match[1]
    mime = "font/woff2" if path.suffix == ".woff2" else "font/ttf"
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f'url("data:{mime};base64,{data}")'


def main():
    html = (ROOT / "index.html").read_text()
    for sheet in ["atlas.css", "sheet.css"]:
        css = re.sub(r'url\("(assets/fonts/[^"]+)"\)', embedded_font, (ROOT / sheet).read_text())
        html = html.replace(f'<link rel="stylesheet" href="{sheet}">', f"<style>\n{css}\n</style>")
    licenses = (ROOT / "assets" / "fonts" / "barlow-license.txt").read_text()
    scripts = re.findall(r'  <script defer src="([^"]+)"></script>\n', html)
    assert scripts == ["assets/plan.js", "sheet.js"]
    html = re.sub(r'  <script defer src="[^"]+"></script>\n', "", html)
    code = "\n".join(f"<script>\n{(ROOT / file).read_text()}\n</script>" for file in scripts)
    html = html.replace("</body>", f'<script type="text/plain" id="font-licenses">{licenses}</script>\n{code}\n</body>')
    OUTPUT.write_text(html)


if __name__ == "__main__":
    main()
