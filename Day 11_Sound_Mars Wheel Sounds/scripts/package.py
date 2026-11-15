"""Create a portable postcard with its recording, basemap, locators and fonts."""
import base64
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIME = {'.ttf': 'font/ttf', '.webp': 'image/webp', '.png': 'image/png', '.mp3': 'audio/mpeg'}


def embed(name):
    path = ROOT / name
    return 'data:' + MIME[path.suffix] + ';base64,' + base64.b64encode(path.read_bytes()).decode('ascii')


css = (ROOT / 'sheet.css').read_text()
css = re.sub(r'url\("(assets/[^"\n]+)"\)', lambda m: 'url("' + embed(m[1]) + '")', css)
html = (ROOT / 'index.html').read_text().replace('<link rel="stylesheet" href="sheet.css">', '<style>\n' + css + '\n</style>')
scripts = re.findall(r'<script defer src="([^"]+)"></script>', html)
html = re.sub(r'  <script defer src="[^"]+"></script>\n', '', html)
html = re.sub(r'src="(assets/[^"]+)"', lambda m: 'src="' + embed(m[1]) + '"', html)
license_text = (ROOT / 'assets/fonts/barlow-license.txt').read_text()
inline = '<script type="text/plain" id="font-license">\n' + license_text + '\n</script>\n'
for script in scripts:
    inline += '<script>\n' + (ROOT / script).read_text() + '\n</script>\n'
output = ROOT / 'Where on Mars Were the Wheels Heard_Oscar Luo.html'
output.write_text(html.replace('</body>', inline + '</body>'))
print(f'{output.name} · {output.stat().st_size:,} bytes')
