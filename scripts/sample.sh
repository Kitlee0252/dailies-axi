#!/bin/bash
set -eu
cd "$(dirname "$0")/.."
mkdir -p source
/opt/homebrew/bin/ffmpeg -y -f lavfi -i 'testsrc2=size=640x360:rate=25:duration=30' -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=30' -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest source/sample.mp4
