// The EDL uses half-open composition and proxy intervals. Source frames are
// decoded presentation-order indexes, and can repeat in a CFR proxy.
export function mapInterval(edl, assets, start, end) {
  return edl.segments.flatMap(segment => {
    const frame = Math.max(start, segment.start_frame);
    const endFrame = Math.min(end, segment.end_frame);
    if (frame >= endFrame) return [];
    const asset = assets[segment.asset];
    const mediaFrame = segment.media_in + frame - segment.start_frame;
    const mediaEnd = mediaFrame + endFrame - frame;
    const sourceFrame = asset.proxy_to_source[mediaFrame];
    const lastSourceFrame = asset.proxy_to_source[mediaEnd - 1];
    // When the end falls inside a repeated frame, include that frame's source
    // interval. Otherwise use the next displayed source PTS as the boundary.
    const nextSource = asset.proxy_to_source[mediaEnd];
    const sourceEnd = Math.max(lastSourceFrame + 1, nextSource ?? lastSourceFrame + 1);
    return [{
      clip: segment.clip, asset: segment.asset, proxy: asset.proxy, source_fps: asset.source_fps,
      source_sha256: asset.source_sha256, frame, end_frame: endFrame,
      media_frame: mediaFrame, media_end_frame: mediaEnd, source_frame: sourceFrame,
      last_source_frame: lastSourceFrame, source_seconds: asset.source_pts[sourceFrame],
      source_end_seconds: asset.source_pts[sourceEnd] ?? asset.duration,
      repeated: asset.repeated_frames?.includes(mediaFrame) ?? false,
    }];
  });
}
