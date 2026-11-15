"""Embed all data, imagery and font files beside the original Barlow license."""
import base64
import mimetypes
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
def data_url(match):
    path = root / match[1]
    mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
    return 'data:'+mime+';base64,'+base64.b64encode(path.read_bytes()).decode()

html = (root/'index.html').read_text()
css = re.sub(r'(?<=url\(")(assets/[^"]+)(?="\))', data_url, (root/'sheet.css').read_text())
html = html.replace('<link rel="stylesheet" href="sheet.css">', '<style>\n'+css+'\n</style>')
html = re.sub(r'(?<=src=")(assets/[^"]+\.(?:webp|png))(?=")', data_url, html)
scripts = re.findall(r'  <script defer src="([^"]+)"></script>\n', html)
html = re.sub(r'  <script defer src="[^"]+"></script>\n', '', html)
embedded = []
for file in scripts:
    source = (root/file).read_text()
    assert '</script' not in source.lower()
    embedded.append('<script>\n'+source+'\n</script>')
license_text = (root/'assets/fonts/barlow-license.txt').read_text()
embedded.append('<script type="text/plain" id="font-license">'+license_text+'</script>')
(root/'Meteorite Landings_Oscar Luo.html').write_text(html.replace('</body>', '\n'.join(embedded)+'\n</body>'))
