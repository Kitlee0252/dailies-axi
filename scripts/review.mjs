import { pickRect, intersects, frameAt } from './regions.mjs';

const $ = selector => document.querySelector(selector);
const iframe = $('#composition'), canvas = $('#canvas'), surface = $('#surface');
const composer = $('#composer'), input = $('#feedback'), seek = $('#seek');
const notes = [];
let port, ready, width, height, fps, frameCount, playback;
let frame = 0, gesture, draft, selectionRequest = 0, anim, sending = false, noteCount = 0;
$('#version').textContent = config.version;
const status = message => { $('#status').textContent = message; };

function resize() {
  if (!ready) return;
  iframe.style.transform = `scale(${canvas.clientWidth / width})`;
  if (draft) placeComposer(draft.rect);
}

function redraw() {
  const active = notes.filter(note => note.frame === frame);
  if (draft) active.push(draft);
  if (gesture?.rect) active.push({ rect: gesture.rect });
  $('#markers').replaceChildren(...active.map(({ rect, id }) => {
    const box = document.createElement('div');
    box.className = 'region';
    Object.assign(box.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`,
      width: `${rect.width * 100}%`, height: `${rect.height * 100}%` });
    if (id) box.append(Object.assign(document.createElement('b'), { textContent: id }));
    return box;
  }));
}

function showFrame(index) {
  frame = index;
  seek.value = index;
  $('#time').textContent = `${(index / fps).toFixed(3)} s · F${index}`;
  redraw();
}

function pause() {
  cancelAnimationFrame(anim);
  playback = null;
  $('#play').textContent = 'Play';
}

function gotoFrame(index) {
  const nextFrame = Math.max(0, Math.min(frameCount - 1, index));
  port.postMessage({ frame: nextFrame });
  showFrame(nextFrame);
}

function tick(now) {
  const index = frameAt(playback.frame / fps + (now - playback.start) / 1000, fps, frameCount);
  if (index !== frame) gotoFrame(index);
  if (index === frameCount - 1) pause();
  else anim = requestAnimationFrame(tick);
}

function closeComposer() {
  draft = null;
  composer.hidden = true;
  input.value = '';
  redraw();
}

$('#play').onclick = () => {
  if (!ready || gesture) return;
  if (playback) return pause();
  closeComposer();
  if (frame === frameCount - 1) gotoFrame(0);
  playback = { frame, start: performance.now() };
  $('#play').textContent = 'Pause';
  anim = requestAnimationFrame(tick);
};

function navigate(index) {
  if (!ready || gesture) return;
  closeComposer();
  pause();
  gotoFrame(index);
}

seek.oninput = () => navigate(Number(seek.value));
$('#previous').onclick = () => navigate(frame - 1);
$('#next').onclick = () => navigate(frame + 1);

function position(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
}

function placeComposer(rect) {
  const left = canvas.offsetLeft + rect.x * canvas.clientWidth;
  const bottom = (rect.y + rect.height) * canvas.clientHeight;
  composer.style.left = `${Math.max(0, Math.min(left, $('#stage').clientWidth - composer.offsetWidth))}px`;
  const above = rect.y * canvas.clientHeight - composer.offsetHeight - 8;
  composer.style.top = `${bottom + composer.offsetHeight + 8 > canvas.clientHeight && above >= 0 ? above : bottom + 8}px`;
}

surface.onpointerdown = event => {
  if (!ready || !event.isPrimary || event.button !== 0 || gesture) return;
  event.preventDefault();
  closeComposer();
  pause();
  gesture = { id: event.pointerId, start: position(event), clientX: event.clientX, clientY: event.clientY };
  if (event.isTrusted) surface.setPointerCapture(event.pointerId);
};

function selection(event) {
  const click = Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) < 5;
  return pickRect(gesture.start, position(event), width, height, click);
}

surface.onpointermove = event => {
  if (gesture?.id !== event.pointerId) return;
  gesture.rect = selection(event);
  redraw();
};

surface.onpointerup = event => {
  if (gesture?.id !== event.pointerId) return;
  const rect = selection(event);
  gesture = null;
  if (rect.width <= 0 || rect.height <= 0) return redraw();
  draft = { version: config.version, time_seconds: frame / fps, frame, rect };
  $('#targets').textContent = 'Finding editable elements…';
  composer.querySelector('[type=submit]').disabled = true;
  port.postMessage({ frame, rect, request: ++selectionRequest });
  composer.hidden = false;
  placeComposer(rect);
  redraw();
  input.focus({ preventScroll: true });
};

surface.onpointercancel = surface.onlostpointercapture = () => { gesture = null; redraw(); };
$('#cancel').onclick = closeComposer;
composer.onkeydown = event => { if (event.key === 'Escape') closeComposer(); };
composer.onsubmit = event => {
  event.preventDefault();
  const text = input.value.trim();
  if (!draft?.targets || !text) return;
  notes.push({ ...draft, id: `N${++noteCount}`, text });
  closeComposer();
  renderNotes();
  status('Note added locally. Send when ready.');
};

function renderNotes() {
  $('#count').textContent = `(${notes.length})`;
  $('#empty').hidden = notes.length > 0;
  $('#send').disabled = sending || !notes.length;
  $('#notes').replaceChildren(...notes.map(note => {
    const item = document.createElement('li');
    const controls = Object.assign(document.createElement('div'), { className: 'row' });
    const jump = Object.assign(document.createElement('button'), { textContent: `${note.id} · Frame ${note.frame}` });
    jump.onclick = () => navigate(note.frame);
    const remove = Object.assign(document.createElement('button'), { textContent: 'Delete', disabled: sending });
    remove.setAttribute('aria-label', `Delete note ${note.id}`);
    remove.onclick = () => { notes.splice(notes.indexOf(note), 1); renderNotes(); };
    controls.append(jump, document.createTextNode(note.targets.map(target => target.selector).join(', ') || 'Background'), remove);
    item.append(controls, Object.assign(document.createElement('p'), { textContent: note.text }));
    return item;
  }));
  redraw();
}

$('#send').onclick = async () => {
  if (sending || !notes.length) return;
  if (!window.lavish?.queuePrompt || !window.lavish?.sendQueuedPrompts) return status('Open with lavish-axi to send feedback.');
  const batch = structuredClone(notes);
  sending = true;
  renderNotes();
  try {
    await window.lavish.queuePrompt(`Apply every region note for ${config.version}.`, { tag: 'video-review',
      text: `${batch.length} region note(s) for ${config.version}`,
      queueKey: `region-review-${config.version}`,
      data: { schema_version: 1, version: config.version, composition: 'composition/index.html',
        width, height, fps, notes: batch } });
    const result = await window.lavish.sendQueuedPrompts();
    if (result === false || result?.ok === false) throw new Error('Lavish rejected this batch');
    notes.splice(0, batch.length);
    status('Submitted to Lavish. The agent can receive this batch through poll.');
  } catch {
    status('Could not send. Notes are still here; try again.');
  } finally {
    sending = false;
    renderNotes();
  }
};

iframe.addEventListener('load', () => {
  const channel = new MessageChannel();
  port = channel.port1;
  const timer = setTimeout(() => status('Cannot load live review: no response from the composition.'), 8500);
  port.onmessage = ({ data }) => {
    if (data.kind === 'targets') {
      if (draft && data.request === selectionRequest) {
        draft.targets = data.targets;
        $('#targets').textContent = draft.targets.map(target => target.selector).join(', ') || 'No editable element · background region';
        composer.querySelector('[type=submit]').disabled = false;
        placeComposer(draft.rect);
      }
      return;
    }
    clearTimeout(timer);
    if (data.kind === 'error') return status(`Cannot load live review: ${data.message}`);
    if (data.kind !== 'ready') return;
    ({ width, height, fps, frameCount } = data);
    ready = true;
    canvas.style.aspectRatio = `${width} / ${height}`;
    Object.assign(iframe.style, { width: `${width}px`, height: `${height}px` });
    resize();
    seek.max = frameCount - 1;
    for (const selector of ['#play', '#previous', '#next', '#seek']) $(selector).disabled = false;
    gotoFrame(0);
    status('Ready. Click or drag on the frame to add feedback.');
  };
  iframe.contentWindow.postMessage('frame-review:connect', '*', [channel.port2]);
}, { once: true });
new ResizeObserver(resize).observe(canvas);
iframe.srcdoc = config.liveComposition;
