"""Package the page with its photograph, drawing, typefaces and font license."""
import base64
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'An Address for a Reader Who Has Never Seen Earth_Oscar Luo.html'


def inline_asset(name, mime):
    encoded = base64.b64encode((ROOT / name).read_bytes()).decode('ascii')
    return f'data:{mime};base64,{encoded}'


def replace_one(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f'Ambiguous HTML source: {old}')
    return text.replace(old, new)


def main():
    html = (ROOT / 'index.html').read_text()
    css = (ROOT / 'sheet.css').read_text()
    for weight in ('medium', 'bold'):
        path = f'assets/fonts/barlow-{weight}.ttf'
        css = replace_one(css, path, inline_asset(path, 'font/ttf'))
    html = replace_one(html, '<link rel="stylesheet" href="sheet.css">', f'<style>\n{css}\n</style>')
    for asset in ('cover-field.webp', 'cover-locator.webp'):
        path = 'assets/' + asset
        html = replace_one(html, path, inline_asset(path, 'image/webp'))
    scripts = []
    for path in ('assets/engraving.js', 'sheet.js'):
        html = replace_one(html, f'<script defer src="{path}"></script>', '')
        scripts.append((ROOT / path).read_text())
    license_text = escape((ROOT / 'assets/fonts/barlow-license.txt').read_text())
    tail = f'<template id="font-license">{license_text}</template>\n'
    for script in scripts:
        if '</script' in script.lower():
            raise ValueError('External script contains a closing script literal')
        tail += '<script>\n' + script + '\n</script>\n'
    html = replace_one(html, '</body>', tail + '</body>')
    OUTPUT.write_text(html)
    print(f'{OUTPUT.name} ({OUTPUT.stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
