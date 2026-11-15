"""Embed the sheet, textures, fonts and ephemeris table for offline sharing."""
import base64
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
def embed(path, mime):
    return 'data:' + mime + ';base64,' + base64.b64encode((root / path).read_bytes()).decode()

html = (root / 'index.html').read_text()
css = (root / 'sheet.css').read_text()
css = re.sub(r'url\("(assets/[^"]+\.ttf)"\)', lambda m: 'url("' + embed(m[1], 'font/ttf') + '")', css)
html = html.replace('<link rel="stylesheet" href="sheet.css">', '<style>\n' + css + '\n</style>')
html = re.sub(r'  <script defer src="[^"]+"></script>\n', '', html)
html = re.sub(r'src="(assets/[^"]+\.webp)"', lambda m: 'src="' + embed(m[1], 'image/webp') + '"', html)
# Preserve the font's redistribution notice in the single-file edition.
license_text = (root / 'assets/fonts/barlow-license.txt').read_text()
html = html.replace('</body>', '<script type="text/plain" id="font-license">' + license_text + '</script>\n' +
    ''.join('<script>\n' + (root / path).read_text() + '\n</script>\n' for path in ['assets/locator-textures.js','assets/ephemeris.js','sightlines.js']) + '</body>')
(root / 'Earth-Moon Sightlines_Oscar Luo.html').write_text(html)
