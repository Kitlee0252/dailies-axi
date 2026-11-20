#!/bin/bash
# Produce the report's five-shot Mandarin fixture in a new private directory.
set -euo pipefail
output=${1:?Pass a new output directory}
mkdir -m 700 "$output"

phrases=('大家好，今天介绍一款新的保温杯。' '嗯，这个，我先说一下包装，包装，算了。'
  '杯身是不锈钢的，可以保温十二个小时。' '价格是九十九元，现在下单还送杯套。' '谢谢观看。')
colors=(0x4979be 0xc556a9 0x519b62 0x89a039 0x7236ca)
frames=(132 160 138 150 58)
speech=(3.45 4.38 3.67 4.04 1.05)
for i in "${!phrases[@]}"; do
  raw="$output/voice-$i.aiff"
  say -v Tingting -o "$raw" "${phrases[i]}"
  seconds=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$raw")
  tempo=$(awk -v actual="$seconds" -v target="${speech[i]}" 'BEGIN {printf "%.9f", actual/target}')
  duration=$(awk -v count="${frames[i]}" 'BEGIN {printf "%.10f", count/30}')
  ffmpeg -nostdin -loglevel error -f lavfi -i "color=c=${colors[i]}:s=384x216:r=30:d=$duration" -i "$raw" \
    -map 0:v -map 1:a -af "atempo=$tempo,atrim=duration=${speech[i]},adelay=300:all=1,apad,atrim=duration=$duration" \
    -ar 48000 -ac 1 -c:a pcm_s16le -c:v libx264 -pix_fmt yuv420p -frames:v "${frames[i]}" "$output/shot-$i.mov"
  printf "file 'shot-%s.mov'\n" "$i" >> "$output/concat.txt"
done
ffmpeg -nostdin -loglevel error -f concat -safe 0 -i "$output/concat.txt" \
  -c:v copy -c:a aac -movflags +faststart "$output/rough.mp4"
