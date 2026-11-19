window.addEventListener('message', async function connect(event) {
  if (event.source !== parent || event.data !== 'frame-review:connect' || event.ports.length !== 1) return;
  window.removeEventListener('message', connect);
  const [port] = event.ports;
  const deadline = performance.now() + 7000;
  while (!window.__playerReady && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  const root = document.querySelector('[data-composition-id]'), player = window.__player;
  if (!root || !player || !window.__playerReady) return port.postMessage({ kind: 'error', message: 'HyperFrames player did not start' });
  const width = Number(root.dataset.width), height = Number(root.dataset.height), fps = Number(root.dataset.fps);
  const frameCount = Math.round(player.getDuration() * fps);
  if (!(width > 0 && height > 0 && fps > 0 && frameCount > 0)) return port.postMessage({ kind: 'error', message: 'Invalid composition geometry or timing' });

  function targetsAt(rect) {
    const origin = root.getBoundingClientRect();
    const center = document.elementFromPoint(origin.left + (rect.x + rect.width / 2) * origin.width,
      origin.top + (rect.y + rect.height / 2) * origin.height)?.closest('[data-review-target][id]');
    return [...root.querySelectorAll('[data-review-target][id]')].filter(element => {
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      const bounds = element.getBoundingClientRect();
      return intersects(rect, { x: (bounds.left - origin.left) / origin.width,
        y: (bounds.top - origin.top) / origin.height, width: bounds.width / origin.width, height: bounds.height / origin.height });
    }).sort((first, second) => Number(second === center) - Number(first === center)).map(element => {
      const style = getComputedStyle(element);
      return { file: 'composition/index.html', id: element.id, selector: `#${CSS.escape(element.id)}`,
        tag: element.localName, text: element.textContent.trim().replace(/\s+/g, ' ').slice(0, 120),
        style: { color: style.color, font_size: style.fontSize } };
    });
  }

  const videos = [...root.querySelectorAll('video[data-review-clip][id]')];
  const activeAt = frame => videos.filter(video => {
    const start = Math.round(Number(video.dataset.start) * fps);
    const count = Math.round(Number(video.dataset.duration) * fps);
    return frame >= start && frame < start + count;
  });
  const proxyFrame = (video, frame) => frame + Math.round(
    (Number(video.dataset.mediaStart ?? 0) - Number(video.dataset.start)) * fps);

  function footageAt(rect, frame) {
    const bounds = root.getBoundingClientRect();
    const pixels = { x: bounds.x + rect.x * bounds.width, y: bounds.y + rect.y * bounds.height,
      width: rect.width * bounds.width, height: rect.height * bounds.height };
    return activeAt(frame).flatMap(video => {
      if (!video.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return [];
      const style = getComputedStyle(video);
      const box = video.getBoundingClientRect();
      const sourceRect = rectInSource(pixels, box, video.videoWidth, video.videoHeight,
        style.objectFit, style.objectPosition, { width: video.clientWidth, height: video.clientHeight });
      return sourceRect ? [{ clip: video.id, media_frame: proxyFrame(video, frame), rect_in_source: sourceRect }] : [];
    });
  }

  function waitForVideo(video, frame) {
    // Seek to the midpoint explicitly when needed. The runtime can quantize
    // a transport seek to a frame boundary, where browser rounding differs.
    const target = frameMidpoint(proxyFrame(video, frame), fps);
    return new Promise((resolve, reject) => {
      if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < .001) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        video.removeEventListener('seeked', settled);
        reject(new Error('The proxy did not finish seeking'));
      }, 5000);
      function settled() {
        if (Math.abs(video.currentTime - target) >= .001) return;
        clearTimeout(timer);
        video.removeEventListener('seeked', settled);
        resolve();
      }
      video.addEventListener('seeked', settled);
      video.currentTime = target;
    });
  }

  let revision = 0, animation;
  function followPlayback(request) {
    const time = player.getTime();
    port.postMessage({ kind: 'playback', frame: frameAt(time, fps, frameCount), playing: player.isPlaying(), request });
    if (player.isPlaying()) animation = requestAnimationFrame(() => followPlayback(request));
  }

  port.onmessage = async ({ data }) => {
    if (!Number.isInteger(data.frame) || data.frame < 0 || data.frame >= frameCount) return;
    const current = ++revision;
    cancelAnimationFrame(animation);
    player.pause();
    player.seek(frameMidpoint(data.frame, fps));
    try {
      await Promise.all(activeAt(data.frame).map(video => waitForVideo(video, data.frame)));
    } catch (error) {
      if (current === revision) port.postMessage({ kind: 'seek-error', message: error.message });
      return;
    }
    if (current !== revision) return;
    port.postMessage({ kind: 'positioned', frame: data.frame, request: data.request,
      ...(data.rect ? { targets: targetsAt(data.rect), footage: footageAt(data.rect, data.frame) } : {}) });
    if (data.play) {
      player.play();
      animation = requestAnimationFrame(() => followPlayback(data.request));
    }
  };
  port.postMessage({ kind: 'ready', width, height, fps, frameCount });
});
