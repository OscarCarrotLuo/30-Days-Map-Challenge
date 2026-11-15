"""Build the local entry point and the self-contained Day 12 sharing edition."""
import base64
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
body = (root / "zaatari_power.html").read_text(encoding="utf-8")
head, main = body.split("<main ", 1)
html = (
    '<!doctype html>\n<html lang="en">\n<head>\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    '<link rel="icon" href="data:,">\n'
    + head + '</head>\n<body>\n<main ' + main + '\n</body>\n</html>\n'
)
(root / "index.html").write_text(html, encoding="utf-8")


def data_url(path, mime):
    data = base64.b64encode((root / path).read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def inline_script(match):
    path = match[1]
    source = (root / path).read_text(encoding="utf-8")
    if path == "data/imagery.js":
        source = re.sub(
            r'"(data/[^"]+\.webp)"',
            lambda image: '"' + data_url(image[1], "image/webp") + '"',
            source,
        )
    assert "</script" not in source.lower(), path
    return "<script>\n" + source + "\n</script>"


share = re.sub(
    r'url\("(assets/fonts/[^"]+\.ttf)"\)',
    lambda font: 'url("' + data_url(font[1], "font/ttf") + '")',
    html,
)
share = re.sub(r'<script src="([^"]+)"></script>', inline_script, share)
notices = "\n\n".join(
    (root / path).read_text(encoding="utf-8")
    for path in ("assets/fonts/barlow-license.txt", "assets/vendor/d3-license.txt")
)
share = share.replace("</body>", '<script type="text/plain" id="licenses">\n' + notices + '\n</script>\n</body>')
target = root / "Who Powers Zaatari_Oscar Luo.html"
target.write_text(share, encoding="utf-8")
print(f"{target.name} · {target.stat().st_size:,} bytes")
