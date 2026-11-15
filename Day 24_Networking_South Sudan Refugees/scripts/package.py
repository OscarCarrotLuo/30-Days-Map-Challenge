"""Build the single-file edition with embedded Barlow fonts and map assets."""
import base64
import mimetypes
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / 'index.html').read_text()
css = (ROOT / 'sheet.css').read_text()
scripts = re.findall(r'<script defer src="([^"]+)"></script>', html)


def embed(name):
    mime = mimetypes.guess_type(name)[0] or 'application/octet-stream'
    encoded = base64.b64encode((ROOT / name).read_bytes()).decode()
    return f'data:{mime};base64,{encoded}'


css = re.sub(r'url\("([^"]+)"\)', lambda m: 'url("' + embed(m[1]) + '")', css)
html = html.replace('<link rel="stylesheet" href="sheet.css">', '<style>\n' + css + '\n</style>')
html = re.sub(r'  <script defer src="[^"]+"></script>\n', '', html)
html = re.sub(r'src="(assets/[^"]+)"', lambda m: 'src="' + embed(m[1]) + '"', html)
license_text = (ROOT / 'assets/fonts/barlow-license.txt').read_text()
body_end = '<script type="text/plain" id="font-license">' + license_text + '</script>\n'
body_end += ''.join('<script>\n' + (ROOT / path).read_text() + '\n</script>\n' for path in scripts)
html = html.replace('</body>', body_end + '</body>')
(ROOT / 'South Sudan Refugee Asylum Network_Oscar Luo.html').write_text(html)
