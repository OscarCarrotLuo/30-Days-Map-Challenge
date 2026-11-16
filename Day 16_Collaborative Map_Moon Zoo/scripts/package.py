"""Resolve the shared Day 2 design and all local assets into one offline sheet."""
import base64
import mimetypes
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DAY2 = ROOT.parent / "Day 2_Line_Moon Contour Lines"
TITLE = "How Closely Do We Trace the Same Crater_Oscar Luo"


def uri(path):
    kind = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return "data:" + kind + ";base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def inline_style(match):
    path = ROOT / match[1]
    content = re.sub(r'url\("([^"]+)"\)', lambda m: 'url("' + uri(path.parent / m[1]) + '")',
                     path.read_text())
    return "<style>\n" + content + "\n</style>"


source = (ROOT / "index.html").read_text()
source = re.sub(r'<link rel="stylesheet" href="([^"]+)">', inline_style, source)
source = re.sub(r'(src=")([^"]+\.(?:png|webp))"', lambda m: m[1] + uri(ROOT / m[2]) + '"', source)
scripts = re.findall(r'  <script defer src="([^"]+)"></script>\n', source)
source = re.sub(r'  <script defer src="([^"]+)"></script>\n', "", source)
license_text = (DAY2 / "assets/fonts/barlow-license.txt").read_text()
scripts = ['<script type="text/plain" id="font-license">' + license_text + "</script>"] + [
    "<script>\n" + (ROOT / script).read_text().replace("</script", "<\\/script") + "\n</script>"
    for script in scripts
]
(ROOT / (TITLE + ".html")).write_text(source.replace("</body>", "\n".join(scripts) + "\n</body>"))
