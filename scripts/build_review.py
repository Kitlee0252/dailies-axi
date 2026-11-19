#!/usr/bin/env python3
import base64, json, pathlib, sys
root=pathlib.Path(__file__).resolve().parent.parent
version=sys.argv[1]
if not version.isalnum(): raise ValueError('invalid version')
video=(root/'renders'/f'{version}.mp4').read_bytes()
mapdata=json.loads((root/'renders'/f'{version}.map.json').read_text())
if mapdata['version'] != version: raise ValueError('map version mismatch')
html=(root/'scripts/review.html').read_text().replace('__VIDEO__','data:video/mp4;base64,'+base64.b64encode(video).decode()).replace('__MAP__',json.dumps(mapdata).replace('<','\\u003c'))
out=root/'review';out.mkdir(exist_ok=True);(out/f'{version}.html').write_text(html)
print(out/f'{version}.html')
