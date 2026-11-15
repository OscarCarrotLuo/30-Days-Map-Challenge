"""Build the portable map from the same source that powers the collection."""
import base64
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
html = (root / "index.html").read_text()
def style(match):
    source = root / match[1]
    def font(m):
        bits = base64.b64encode((source.parent / m[1]).read_bytes()).decode()
        return 'url("data:font/ttf;base64,' + bits + '")'
    return "<style>\n" + re.sub(r'url\("([^"]+\.ttf)"\)', font, source.read_text()) + "\n</style>"
html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', style, html)
scripts = re.findall(r'<script defer src="([^"]+)"></script>', html)
html = re.sub(r'  <script defer src="[^"]+"></script>\n', "", html)
license_path = root.parent / "Day 2_Line_Moon Contour Lines/assets/fonts/barlow-license.txt"
embedded = '<script type="text/plain" id="font-license">' + license_path.read_text() + '</script>\n'
embedded += "".join("<script>\n" + (root / path).read_text() + "\n</script>\n" for path in scripts)
(root / "Voyager 2 Gravity Assists_Oscar Luo.html").write_text(html.replace("</body>", embedded + "</body>"))
