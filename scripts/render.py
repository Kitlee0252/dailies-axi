#!/usr/bin/env python3
import json, pathlib, subprocess, sys
root = pathlib.Path(__file__).resolve().parent.parent
edit = json.loads((root / sys.argv[1]).read_text())
version = edit['version']
if not version.isalnum(): raise ValueError('version must be alphanumeric')
out = root / 'renders'; out.mkdir(exist_ok=True)
segments = edit['segments']; ids = set(); offset = 0; mapping = []; filters = []
if not segments: raise ValueError('at least one segment is required')
for i, seg in enumerate(segments):
    a, b = float(seg['in']), float(seg['out'])
    if a < 0 or b <= a or seg['id'] in ids: raise ValueError('invalid segment')
    ids.add(seg['id']); duration = b-a
    mapping.append(dict(id=seg['id'], output_start=offset, output_end=offset+duration, source_start=a, source_end=b)); offset += duration
    filters += [f'[0:v]trim=start={a}:end={b},setpts=PTS-STARTPTS[v{i}]',f'[0:a]atrim=start={a}:end={b},asetpts=PTS-STARTPTS,volume={float(seg.get("volume",1))*float(edit.get("volume",1))}[a{i}]']
filters.append(''.join(f'[v{i}][a{i}]' for i in range(len(segments)))+f'concat=n={len(segments)}:v=1:a=1[vcat][aout]')
# Render transparent text images using macOS AppKit; this ffmpeg lacks drawtext.
texts = edit.get('subtitles', []) + edit.get('overlays', [])
inputs = []
for i, item in enumerate(texts):
    image = out / f'{version}-text-{i}.png'
    subprocess.run(['/usr/bin/swift', str(root/'scripts/text.swift'), item['text'], str(image)], check=True)
    inputs += ['-loop', '1', '-i', str(image)]
    position = {'top':'30','center':'(H-h)/2','bottom':'H-h-30'}[item['position']]
    inp = 'vcat' if i == 0 else f't{i-1}'; dest = 'vout' if i == len(texts)-1 else f't{i}'
    filters.append(f"[{inp}][{i+1}:v]overlay=x=(W-w)/2:y={position}:enable='between(t,{float(item['start'])},{float(item['end'])})':shortest=1[{dest}]")
video = 'vout' if texts else 'vcat'
subprocess.run(['/opt/homebrew/bin/ffmpeg','-y','-i',str(root/edit['source'])]+inputs+['-filter_complex',';'.join(filters),'-map',f'[{video}]','-map','[aout]','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',str(out/f'{version}.mp4')],check=True)
(out/f'{version}.map.json').write_text(json.dumps({'version':version,'segments':mapping},indent=2)+'\n')
