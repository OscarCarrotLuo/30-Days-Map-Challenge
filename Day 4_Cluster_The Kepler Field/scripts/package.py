"""Embed the complete interactive sheet in a single offline HTML file."""
import base64
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def uri(name, mime):
    encoded = base64.b64encode((ROOT / name).read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


html = (ROOT / "index.html").read_text()
css = (ROOT / "sheet.css").read_text()
css = re.sub(r'url\("(assets/[^"]+\.ttf)"\)',
             lambda m: 'url("' + uri(m[1], "font/ttf") + '")', css)
html = html.replace('<link rel="stylesheet" href="sheet.css">', '<style>\n' + css + '\n</style>')
html = re.sub(r'src="(assets/[^"]+\.webp)"',
              lambda m: 'src="' + uri(m[1], "image/webp") + '"', html)
script_paths = re.findall(r'<script defer src="([^"]+)"></script>', html)
html = re.sub(r'  <script defer src="[^"]+"></script>\n', '', html)
license_text = (ROOT / "assets/fonts/barlow-license.txt").read_text()
scripts = ['<script type="text/plain" id="font-license">' + license_text + '</script>']
for path in script_paths:
    source = (ROOT / path).read_text().replace("</script", "<\\/script")
    scripts.append("<script>\n" + source + "\n</script>")
html = html.replace("</body>", "\n".join(scripts) + "\n</body>")
(ROOT / "The Kepler Field_Oscar Luo.html").write_text(html)
