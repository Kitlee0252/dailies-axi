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

  port.onmessage = ({ data }) => {
    if (!Number.isInteger(data.frame) || data.frame < 0 || data.frame >= frameCount) return;
    player.seek(data.frame / fps);
    if (data.rect) port.postMessage({ kind: 'targets', request: data.request, targets: targetsAt(data.rect) });
  };
  port.postMessage({ kind: 'ready', width, height, fps, frameCount });
});
