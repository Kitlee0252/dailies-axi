import { pickRect, frameAt } from './regions.mjs';
import { mapInterval, shotSpans, snapToCut } from './edl.mjs';
import { commentAt, feedbackPrompt, sortNotes } from './feedback-format.mjs';
import { correctTranscript, transcriptCues, withSpoken } from './spoken.mjs';
import { joinWords } from './transcript.mjs';
import { updateSelection } from './review-selection.mjs';

const $ = selector => document.querySelector(selector);
const iframe = $('#composition'), canvas = $('#canvas'), surface = $('#surface');
const composer = $('#composer'), input = $('#feedback'), seek = $('#seek'), timeline = $('#timeline'), send = $('#send');
const playhead = Object.assign(document.createElement('span'), { className: 'playhead' });
const wordsList = $('#words'), overlay = $('#transcript-overlay'), overlayToggle = $('#toggle-transcript');
const { edl, assets, transcripts, version, record } = config;
let notes = [], locked = false, stateLoaded = false, sent = false;
const reactions = new Map();
const reviewers = record.reviewers ?? [];
let reviewer = reviewers.length === 1 ? reviewers[0].id : 'anonymous';
const reactionKey = (ref, actor) => `${ref}:${actor}`;
let port, ready, width, height, fps, frameCount, playing = false, positioned = false;
let frame = 0, gesture, draft, request = 0, noteCount = 0, range, dragRange;
let cues = [], currentCue, editingCue, composerAnchor, overlayDrag;
let overlayPosition = record.overlay_position ?? .76;
let transcriptEdits = [], reviewedTranscripts = transcripts;
$('#version').textContent = version;
const status = message => { $('#status').textContent = message; };
const editable = () => ready && stateLoaded && !locked && !sent;
const hasFeedback = () => notes.length > 0 || transcriptEdits.length > 0;

function resize() {
  if (!ready) return;
  iframe.style.transform = `scale(${canvas.clientWidth / width})`;
  placeComposer();
  positionOverlay();
}

function positionPlayhead() {
  playhead.style.transform = `translateX(${(frame + .5) / frameCount * timeline.clientWidth}px)`;
}

function redraw() {
  const active = notes.filter(note => note.rect && note.frame === frame);
  if (draft?.rect) active.push(draft);
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

function drawTimeline() {
  const selected = dragRange ? dragRange.preview : range;
  const spans = [
    ...edl.segments.map(segment => [segment.start_frame, segment.end_frame, 'clip-span']),
    ...notes.filter(note => note.kind === 'range').map(note => [note.frame, note.end_frame, 'noted-span']),
    ...(selected ? [[selected.start, selected.end, 'selected-span']] : []),
    ...(edl.cuts ?? []).map(cut => [cut, cut, 'cut-mark']),
  ];
  timeline.replaceChildren(...spans.map(([start, end, className]) => {
    const span = Object.assign(document.createElement('span'), { className });
    span.style.left = `${start / frameCount * 100}%`;
    if (end > start) span.style.width = `${(end - start) / frameCount * 100}%`;
    return span;
  }));
  timeline.append(playhead);
  clearRange.disabled = !selected;
  for (const cue of cues) {
    cue.button.classList.toggle('in-range', Boolean(selected && cue.start < selected.end && cue.end > selected.start));
  }
  updateRangeFields();
}

function selectRange(action) {
  range = updateSelection(range, action);
  drawTimeline();
}

function updateRangeFields() {
  const selected = dragRange?.preview ?? range;
  $('#range-start').value = selected?.start ?? frame;
  $('#range-end').value = selected?.end ?? Math.min(frame + 1, frameCount);
}

function showFrame(index) {
  frame = index;
  seek.value = index;
  positionPlayhead();
  $('#time').textContent = `${(index / fps).toFixed(3)} s · F${index}`;
  const spans = mapInterval(edl, assets, index, index + 1);
  $('#source-frame').textContent = spans.map(span =>
    `${span.clip} · source F${span.source_frame}${span.repeated ? ' · repeated proxy frame' : ''}`).join(' / ');
  if (!range && (!dragRange || dragRange.scrub)) updateRangeFields();
  syncTranscript();
  redraw();
}

function seekFrame(index, { play = false, rect } = {}) {
  const next = Math.max(0, Math.min(frameCount - 1, index));
  positioned = false;
  playing = play;
  $('#play').textContent = play ? 'Pause' : 'Play';
  showFrame(next);
  port.postMessage({ frame: next, play, rect, request: ++request });
}

function closeComposer() {
  const restoreFocus = draft && composer.contains(document.activeElement);
  draft = null;
  composer.hidden = true;
  input.value = '';
  if (restoreFocus) composerAnchor?.focus({ preventScroll: true });
  composerAnchor = null;
  redraw();
}

$('#play').onclick = () => {
  if (!ready || gesture || dragRange) return;
  closeComposer();
  seekFrame(!playing && frame === frameCount - 1 ? 0 : frame, { play: !playing });
};

function navigate(index, selection) {
  if (!ready || gesture || dragRange) return;
  closeComposer();
  if (selection) selectRange(selection);
  seekFrame(index);
}

seek.oninput = () => navigate(Number(seek.value));
$('#previous').onclick = () => navigate(frame - 1);
$('#next').onclick = () => navigate(frame + 1);

function position(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
}

function placeComposer() {
  if (!draft) return;
  let anchor = (composerAnchor?.isConnected ? composerAnchor : timeline).getBoundingClientRect();
  if (draft.rect) {
    const bounds = canvas.getBoundingClientRect();
    const { x, y, height } = draft.rect;
    anchor = { left: bounds.left + x * bounds.width, top: bounds.top + y * bounds.height,
      bottom: bounds.top + (y + height) * bounds.height };
  }
  const gap = 8;
  const { offsetHeight, offsetWidth } = composer;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const below = anchor.bottom + gap, above = anchor.top - offsetHeight - gap;
  const y = below + offsetHeight <= viewportHeight - gap || above < gap ? below : above;
  const x = Math.max(gap, Math.min(anchor.left, viewportWidth - offsetWidth - gap));
  composer.style.transform = `translate(${x}px, ${Math.max(gap, Math.min(y, viewportHeight - offsetHeight - gap))}px)`;
}

function openComposer(note, waiting = false, anchor = document.activeElement) {
  composerAnchor = anchor;
  draft = { ...note, version, time_seconds: note.frame / fps, targets: [] };
  $('#targets').textContent = waiting ? 'Finding editable elements and footage…' : commentAt(draft);
  composer.querySelector('[type=submit]').disabled = waiting;
  composer.hidden = false;
  placeComposer();
  redraw();
  input.focus({ preventScroll: true });
}

surface.onpointerdown = event => {
  if (!editable() || (!positioned && !playing) || !event.isPrimary || event.button !== 0 || gesture || dragRange) return;
  event.preventDefault();
  closeComposer();
  if (playing) seekFrame(frame);
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
  if (!editable() || rect.width <= 0 || rect.height <= 0) return redraw();
  // Range rectangles are evaluated at the currently displayed frame, even
  // when the selected range starts on a different clip.
  const regionFrame = frame;
  const scoped = range && regionFrame >= range.start && regionFrame < range.end;
  openComposer(scoped
    ? { kind: 'range', frame: range.start, end_frame: range.end, region_frame: regionFrame, rect }
    : { kind: 'pin', frame: regionFrame, rect }, true, timeline);
  seekFrame(regionFrame, { rect });
};

surface.onpointercancel = surface.onlostpointercapture = () => { gesture = null; redraw(); };

function timelineFrame(event) {
  const bounds = timeline.getBoundingClientRect();
  return frameAt((event.clientX - bounds.left) / bounds.width * frameCount, 1, frameCount);
}
timeline.onpointerdown = event => {
  if (!ready || gesture || dragRange || !event.isPrimary || event.button !== 0) return;
  closeComposer();
  const start = timelineFrame(event);
  const scrub = event.target === playhead || Math.abs(event.clientX - playhead.getBoundingClientRect().left - 1) <= 7;
  dragRange = { id: event.pointerId, origin: start, x: event.clientX, preview: range, scrub };
  if (event.isTrusted) timeline.setPointerCapture(event.pointerId);
  seekFrame(scrub ? frame : start);
};
timeline.onpointermove = event => {
  if (dragRange?.id !== event.pointerId) return;
  if (!dragRange.dragged && Math.abs(event.clientX - dragRange.x) < 5) return;
  dragRange.dragged = true;
  const index = timelineFrame(event);
  if (dragRange.scrub) {
    if (index !== frame) seekFrame(index);
    return;
  }
  let start = Math.min(index, dragRange.origin), end = Math.max(index, dragRange.origin) + 1;
  // A dragged range snaps each edge to a shot cut within a fifth of a second.
  if (end - start > 2) {
    const tolerance = Math.max(2, Math.round(fps / 5));
    start = snapToCut(edl, start, tolerance);
    end = Math.max(start + 1, snapToCut(edl, end, tolerance));
  }
  dragRange.preview = { start, end };
  drawTimeline();
};
timeline.onpointerup = event => {
  if (dragRange?.id !== event.pointerId) return;
  timeline.onpointermove(event);
  if (dragRange.scrub && dragRange.dragged) {
    dragRange = null;
    updateRangeFields();
    return;
  }
  const selected = dragRange.dragged ? dragRange.preview : null;
  dragRange = null;
  selectRange(selected ? { type: 'range', ...selected } : { type: 'clear' });
  const index = selected?.start ?? timelineFrame(event);
  if (index !== frame) seekFrame(index);
};
timeline.onpointercancel = timeline.onlostpointercapture = event => {
  if (dragRange?.id !== event.pointerId) return;
  dragRange = null;
  drawTimeline();
};

for (const selector of ['#range-start', '#range-end']) {
  $(selector).onchange = () => {
    if (!ready) return;
    const start = Math.max(0, Math.min(frameCount - 1, Math.round(Number($('#range-start').value))));
    const end = Math.max(start + 1, Math.min(frameCount, Math.round(Number($('#range-end').value))));
    navigate(start, { type: 'range', start, end });
  };
}
const clearRange = $('#clear-range');
clearRange.onclick = () => {
  closeComposer();
  dragRange = null;
  if (document.activeElement === clearRange) timeline.focus({ preventScroll: true });
  selectRange({ type: 'clear' });
};
$('#add-range').onclick = () => {
  if (!editable()) return;
  const start = range?.start ?? frame, end = range?.end ?? frame + 1;
  seekFrame(start);
  openComposer({ kind: 'range', frame: start, end_frame: end }, false, $('#add-range'));
};
$('#whole').onclick = () => {
  if (!editable()) return;
  if (playing) seekFrame(frame);
  openComposer({ kind: 'general', frame: 0, end_frame: frameCount, whole_video: true }, false, $('#whole'));
};
document.addEventListener('keydown', event => {
  if (event.altKey || event.metaKey || event.ctrlKey || event.defaultPrevented) return;
  if (event.key === 'Escape' && (range || dragRange)) {
    clearRange.click();
    return;
  }
  if (!ready || draft || event.target.closest('textarea,input,select,[contenteditable=true]')) return;
  if (event.key.toLowerCase() === 'w' && !event.target.closest('button')) $('#whole').click();
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const delta = event.key === 'ArrowLeft' ? -1 : 1;
    if (event.shiftKey) {
      if (!range || dragRange || gesture) return;
      event.preventDefault();
      selectRange({ type: 'adjust-end', delta, frameCount });
      return;
    }
    event.preventDefault();
    navigate(frame + delta);
  }
});

$('#cancel').onclick = closeComposer;
composer.onkeydown = event => {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  closeComposer();
};
composer.onsubmit = event => {
  event.preventDefault();
  const text = input.value.trim();
  if (!editable() || !draft || composer.querySelector('[type=submit]').disabled || !text) return;
  const spans = mapInterval(edl, assets, draft.frame, draft.end_frame ?? draft.frame + 1);
  const shots = draft.whole_video || !edl.segments.length ? {}
    : { shots: shotSpans(edl, draft.frame, draft.end_frame ?? draft.frame + 1) };
  const note = withSpoken({ ...draft, id: `N${++noteCount}`, text, ...shots,
    ...(reviewers.length > 1 ? { reviewer } : {}) }, spans, reviewedTranscripts, edl);
  notes.push(note);
  range = null;
  closeComposer();
  renderNotes();
  status('Note added locally. Send when ready.');
};

function mediaBoundary(asset, low, high, seconds, strictlyAfter) {
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const pts = asset.source_pts[asset.proxy_to_source[middle]];
    if (pts < seconds || (strictlyAfter && pts === seconds)) low = middle + 1;
    else high = middle;
  }
  return low;
}

function renderTranscript() {
  cues = edl.segments.flatMap(segment => {
    const asset = assets[segment.asset];
    const startSeconds = segment.source_in_seconds, endSeconds = segment.source_out_seconds;
    const transcript = transcripts[segment.asset];
    const indexes = new Map(transcript?.words.map((word, index) => [word, index]));
    return transcriptCues(transcript).flatMap(cue => {
      // Show only words this segment plays, so trimmed speech disappears from later versions.
      // Any overlap counts because Whisper's word times can be a few tenths of a second off.
      const words = cue.words.filter(word => word.end > startSeconds && word.start < endSeconds);
      if (!words.some(word => /[\p{L}\p{N}]/u.test(word.text))) return [];
      const cueStart = words[0].start, cueEnd = Math.max(...words.map(word => word.end));
      const boundary = mediaBoundary(asset, segment.media_in, segment.media_out, cueStart, true);
      let start = Math.max(segment.media_in, boundary - 1);
      // Repeats can share the cue's exact start PTS.
      if (asset.source_pts[asset.proxy_to_source[start]] === cueStart) {
        start = mediaBoundary(asset, segment.media_in, boundary, cueStart, false);
      }
      const end = mediaBoundary(asset, start + 1, segment.media_out, cueEnd, false);
      const first = segment.start_frame + start - segment.media_in;
      const last = segment.start_frame + end - segment.media_in;
      const button = Object.assign(document.createElement('button'), {
        type: 'button', className: 'cue-text',
      });
      const bounds = { start: first, end: last };
      button.onclick = event => {
        navigate(first, event.shiftKey ? { type: 'cue', cue: bounds } : { type: 'clear' });
      };
      const editor = Object.assign(document.createElement('input'), {
        className: 'cue-editor', type: 'text', maxLength: 1000, hidden: true,
      });
      editor.setAttribute('aria-label', `Transcript line at F${first}`);
      const edit = Object.assign(document.createElement('button'), { type: 'button', className: 'cue-edit' });
      const row = Object.assign(document.createElement('div'), { className: 'transcript-line' });
      row.append(button, editor, edit);
      const line = { ...bounds, asset: segment.asset, from: indexes.get(words[0]),
        to: indexes.get(words.at(-1)) + 1, row, button, edit, editor };
      edit.onclick = () => {
        if (editingCue === line) finishCueEdit(true);
        else startCueEdit(line);
      };
      editor.onkeydown = event => {
        if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return;
        event.preventDefault();
        event.stopPropagation();
        finishCueEdit(event.key === 'Enter');
      };
      return [line];
    });
  });
  $('#transcript').hidden = overlayToggle.hidden = !cues.length;
  wordsList.replaceChildren(...cues.map(cue => cue.row));
  refreshCueText();
  syncTranscript();
}

function refreshCueText() {
  for (const cue of cues) {
    const original = transcripts[cue.asset].words;
    const edits = transcriptEdits.filter(edit => edit.asset === cue.asset && edit.from < cue.to && edit.to > cue.from)
      .sort((a, b) => a.from - b.from);
    const pieces = [];
    let i = cue.from;
    for (const edit of edits) {
      pieces.push(...original.slice(i, Math.max(i, edit.from)).map(word => word.text), edit.text);
      i = edit.to;
    }
    const untouched = original.slice(i, cue.to);
    pieces.push(...untouched.map(word => word.text));
    cue.text = joinWords(pieces);
    const changed = edits.length || untouched.some(word => word.review_edited);
    cue.button.textContent = cue.text;
    cue.button.title = `${cue.text}\nJump to F${cue.start}. Shift-click to select or extend a range.`;
    cue.row.classList.toggle('edited', Boolean(changed));
    cue.button.setAttribute('aria-label', changed ? `${cue.text} (edited)` : cue.text);
    updateCueEditButton(cue);
  }
  updateOverlay();
}

function updateCueEditButton(cue) {
  const active = editingCue === cue;
  cue.edit.textContent = active ? 'Done' : 'Edit';
  cue.edit.setAttribute('aria-label', `${active ? 'Done editing' : 'Edit'} transcript at F${cue.start}`);
}

function startCueEdit(cue) {
  if (!editable()) return;
  finishCueEdit(false, false);
  editingCue = cue;
  cue.editor.value = cue.text;
  cue.button.hidden = true;
  cue.editor.hidden = false;
  updateCueEditButton(cue);
  cue.editor.focus({ preventScroll: true });
  cue.editor.select();
}

function finishCueEdit(save, restoreFocus = true) {
  if (!editingCue) return;
  const cue = editingCue;
  const text = cue.editor.value.trim();
  if (save && editable() && !text) {
    status('Enter the corrected line, or press Esc to cancel.');
    cue.editor.focus({ preventScroll: true });
    return;
  }
  editingCue = undefined;
  cue.editor.hidden = true;
  cue.button.hidden = false;
  updateCueEditButton(cue);
  if (restoreFocus) cue.edit.focus({ preventScroll: true });
  if (!save || !editable() || text === cue.text) return;
  const original = transcripts[cue.asset].words.slice(cue.from, cue.to);
  const edits = transcriptEdits.filter(edit => edit.asset !== cue.asset || edit.to <= cue.from || edit.from >= cue.to);
  if (text !== joinWords(original.map(word => word.text))) {
    edits.push({ asset: cue.asset, from: cue.from, to: cue.to, text });
  }
  applyTranscriptEdits(edits);
  notes = notes.map(({ source, spoken, spoken_around, ...note }) =>
    withSpoken(note, mapInterval(edl, assets, note.frame, note.end_frame ?? note.frame + 1), reviewedTranscripts, edl));
  renderNotes();
  status('Transcript corrected locally. Send feedback to save it for the next version.');
}

function applyTranscriptEdits(edits) {
  transcriptEdits = edits;
  reviewedTranscripts = Object.fromEntries(Object.entries(transcripts).map(([asset, transcript]) =>
    [asset, correctTranscript(transcript, edits.filter(edit => edit.asset === asset))]));
  refreshCueText();
}

function scrollToCurrentCue() {
  if (!currentCue) return;
  const list = wordsList.getBoundingClientRect();
  const line = currentCue.row.getBoundingClientRect();
  // Scroll only the transcript so the video and transport stay in view.
  if (line.top < list.top) wordsList.scrollTop += line.top - list.top;
  else if (line.bottom > list.bottom) wordsList.scrollTop += line.bottom - list.bottom;
}

function updateOverlay() {
  overlay.hidden = !currentCue || overlayToggle.getAttribute('aria-pressed') !== 'true';
  $('#overlay-text').textContent = overlay.hidden ? '' : currentCue.text;
  positionOverlay();
}

function syncTranscript() {
  const next = cues.findLast(cue => cue.start <= frame && frame < cue.end);
  if (next === currentCue) return;
  currentCue?.button.removeAttribute('aria-current');
  currentCue = next;
  currentCue?.button.setAttribute('aria-current', 'true');
  scrollToCurrentCue();
  updateOverlay();
}

overlayToggle.onclick = () => {
  overlayToggle.setAttribute('aria-pressed', overlayToggle.getAttribute('aria-pressed') !== 'true');
  updateOverlay();
};

function positionOverlay() {
  if (overlay.hidden) return;
  const margin = Math.min(.5, overlay.offsetHeight / (2 * canvas.clientHeight));
  const y = Math.max(margin, Math.min(1 - margin, overlayPosition)) * canvas.clientHeight;
  overlay.style.transform = `translate(-50%, calc(${y}px - 50%))`;
}

overlay.onpointerdown = event => {
  if (!event.isPrimary || event.button !== 0) return;
  const bounds = overlay.getBoundingClientRect();
  overlayDrag = { id: event.pointerId, offset: event.clientY - (bounds.top + bounds.height / 2) };
  if (event.isTrusted) overlay.setPointerCapture(event.pointerId);
};
overlay.onpointermove = event => {
  if (overlayDrag?.id !== event.pointerId) return;
  const canvasBounds = canvas.getBoundingClientRect();
  overlayPosition = Math.max(0, Math.min(1, (event.clientY - overlayDrag.offset - canvasBounds.top) / canvasBounds.height));
  positionOverlay();
};
overlay.onpointerup = overlay.onpointercancel = overlay.onlostpointercapture = () => { overlayDrag = undefined; };

function renderNotes() {
  $('#count').textContent = `(${notes.length})`;
  $('#empty').hidden = notes.length > 0;
  send.disabled = !editable() || !hasFeedback();
  send.setAttribute('aria-disabled', String(send.disabled));
  for (const selector of ['#add-range', '#whole']) $(selector).disabled = !editable();
  for (const cue of cues) cue.edit.disabled = !editable();
  $('#reviewer').disabled = !editable();
  surface.classList.toggle('locked', locked || sent);
  $('#notes').replaceChildren(...sortNotes(notes).map(note => {
    const item = document.createElement('li');
    const controls = Object.assign(document.createElement('div'), { className: 'row' });
    const jump = Object.assign(document.createElement('button'), { textContent: `${note.id} · ${commentAt(note)}` });
    jump.onclick = () => navigate(note.region_frame ?? note.frame);
    controls.append(jump);
    const targets = note.targets?.map(target => target.selector).join(', ');
    if (targets) controls.append(document.createTextNode(targets));
    if (editable()) {
      const remove = Object.assign(document.createElement('button'), { textContent: 'Delete' });
      remove.setAttribute('aria-label', `Delete note ${note.id}`);
      remove.onclick = () => {
        if (editable()) { notes.splice(notes.indexOf(note), 1); renderNotes(); }
      };
      controls.append(remove);
    }
    item.append(controls, Object.assign(document.createElement('p'), { textContent: note.text }));
    if (note.reopens) item.append(Object.assign(document.createElement('p'), { textContent: `Reopens ${note.reopens}` }));
    const spoken = note.spoken ?? note.spoken_around;
    if (spoken) item.append(Object.assign(document.createElement('p'), { textContent: `Spoken · ${spoken}` }));
    const resolution = nextVersion?.resolutions[note.id];
    if (resolution) {
      const outcome = Object.assign(document.createElement('p'), {
        textContent: `${resolution.status === 'pending' ? 'Pending in' : 'Addressed in'} ${resolution.version} · ${resolution.note}`,
      });
      for (const [start, end] of outcomeTargets(resolution)) {
        if (!nextVersion.review_url) continue;
        const url = new URL(nextVersion.review_url);
        if (!['http:', 'https:'].includes(url.protocol)) continue;
        url.searchParams.set('dailies-frame', start);
        if (end !== undefined) url.searchParams.set('dailies-end', end);
        const link = Object.assign(document.createElement('a'), {
          href: url.href, target: '_blank', rel: 'noopener',
          textContent: end === undefined ? `Open ${resolution.version} at F${start}`
            : `Open ${resolution.version} at F${start}–F${end}`,
        });
        outcome.append(' ', link);
      }
      item.append(outcome);
    }
    return item;
  }));
  drawTimeline();
  redraw();
}

let nextVersion;
window.reviewState = state => {
  let changed = false;
  if ('notes' in state) {
    changed = !stateLoaded;
    stateLoaded = true;
    if (state.notes) {
      const firstLock = !locked;
      locked = true;
      changed = firstLock;
      notes = state.notes;
      reviewer = state.reviewer ?? reviewer;
      $('#reviewer').value = reviewer;
      reactions.clear();
      for (const reaction of state.reactions ?? []) reactions.set(
        reactionKey(reaction.outcome, reaction.reviewer ?? reviewer), reaction);
      if (firstLock) {
        closeComposer();
        finishCueEdit(false);
        applyTranscriptEdits(state.transcript_edits ?? []);
        if (Number.isFinite(state.overlay_position)) overlayPosition = state.overlay_position;
        positionOverlay();
        status('Feedback locked. This round is read-only.');
      }
    }
  }
  if (state.next) {
    changed = JSON.stringify(state.next) !== JSON.stringify(nextVersion) || changed;
    nextVersion = state.next;
  }
  if (ready && changed) {
    renderNotes();
    renderHistory();
  }
};
function refreshState(file) {
  const script = document.createElement('script');
  script.src = `${file}?t=${Date.now()}`;
  script.onload = script.onerror = () => script.remove();
  document.head.append(script);
}
function refreshReview() {
  if (!locked) refreshState('notes.js');
  if (!nextVersion?.review_url) refreshState('next.js');
}
refreshReview();
setInterval(refreshReview, 2000);

function outcomeTargets(result) {
  const targets = result?.frames ?? (result?.frame === undefined ? [] : [[result.frame, result.end_frame]]);
  return targets.map(([start, end]) => [start, end === start + 1 ? undefined : end]);
}

function initialPosition() {
  const url = new URL(document.referrer || document.URL);
  if (!url.searchParams.has('dailies-frame')) return 0;
  const value = key => /^\d+$/.test(url.searchParams.get(key) ?? '') ? Number(url.searchParams.get(key)) : undefined;
  const start = value('dailies-frame');
  const end = value('dailies-end');
  if (start === undefined || start >= frameCount) return 0;
  if (end > start && end <= frameCount) range = { start, end };
  return start;
}

function renderHistory() {
  if (!record.parent) return;
  $('#history').hidden = false;
  $('#version-summary').textContent = record.note || `Follow-up to ${record.parent}`;
  $('#previous-notes').replaceChildren(...config.previousNotes.map(note => {
    const result = record.resolutions[note.id];
    const row = Object.assign(document.createElement('li'), {
      textContent: `${note.id} · ${note.text} → ${result?.note ?? 'No outcome recorded'}`,
    });
    for (const [start, end] of outcomeTargets(result)) {
      const button = Object.assign(document.createElement('button'), {
        type: 'button', disabled: !ready,
        textContent: end === undefined ? `Jump to F${start}` : `Jump to F${start}–F${end} (end excluded)`,
      });
      button.onclick = () => {
        if (!ready || gesture) return;
        range = end === undefined ? null : { start, end };
        navigate(start);
        drawTimeline();
      };
      row.append(' ', button);
    }
    if (result) appendOutcomeFeedback(row, `${record.parent}:${note.id}`, result, note);
    return row;
  }));
}

function appendOutcomeFeedback(row, outcome, result, note) {
  for (const item of result.learned ?? []) {
    row.append(Object.assign(document.createElement('p'), {
      textContent: `${item.layer === 'reviewer' ? 'Based on your preference' : 'Based on an approved general preference'} · ${item.evidence} ${item.undo}`,
    }));
  }
  const key = reactionKey(outcome, reviewer);
  const selected = reactions.get(key);
  const choices = [
    ['Accept', { verdict: 'accept' }], ['Reject', { verdict: 'reject' }],
    ...(result.alternatives ?? []).map(alt => [
      `Choose ${alt.id}${alt.label ? ` · ${alt.label}` : alt.value !== undefined ? ` · ${alt.value}` :
        alt.treatment ? ` · ${alt.treatment}` : alt.direction ? ` · ${alt.direction}` : ''}`,
      { choice: alt.id },
    ]),
  ];
  if (editable()) {
    const controls = Object.assign(document.createElement('div'), { className: 'row outcome-feedback' });
    for (const [label, signal] of choices) {
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
      const pressed = Object.entries(signal).every(([key, value]) => selected?.[key] === value);
      button.setAttribute('aria-pressed', pressed);
      button.onclick = () => {
        if (!editable()) return;
        const wasPressed = button.getAttribute('aria-pressed') === 'true';
        if (wasPressed) reactions.delete(key);
        else reactions.set(key, { outcome, ...signal, ...(reviewers.length > 1 ? { reviewer } : {}) });
        for (const other of controls.querySelectorAll('button[aria-pressed]')) {
          other.setAttribute('aria-pressed', !wasPressed && other === button);
        }
        renderNotes();
      };
      controls.append(button);
    }
    const reopen = Object.assign(document.createElement('button'), { type: 'button', textContent: `Reopen ${outcome}` });
    reopen.onclick = () => {
      if (!editable()) return;
      if (note.whole_video) {
        openComposer({ kind: 'general', frame: 0, end_frame: frameCount, whole_video: true, reopens: outcome });
      } else {
        const [start, end] = outcomeTargets(result)[0] ?? [frame];
        seekFrame(start);
        openComposer({ kind: 'range', frame: start, end_frame: end ?? start + 1, reopens: outcome });
      }
    };
    controls.append(reopen);
    row.append(controls);
  } else if (selected) {
    row.append(Object.assign(document.createElement('p'), {
      textContent: selected.choice ? `Selected ${selected.choice}` : selected.verdict === 'accept' ? 'Accepted' : 'Rejected',
    }));
  }
}

const identity = $('#reviewer');
identity.replaceChildren(...[{ id: 'anonymous', role: 'Anonymous' }, ...reviewers].map(item =>
  new Option(item.role || item.id, item.id)));
identity.value = reviewer;
identity.onchange = () => {
  if (!editable()) return;
  reviewer = identity.value;
  renderHistory();
};
$('#reviewer-field').hidden = reviewers.length < 2;
renderHistory();

send.onclick = async () => {
  if (!editable() || !hasFeedback()) return;
  if (editingCue) return status('Press Enter to save the transcript edit, or Esc to cancel.');
  if (!window.lavish?.queuePrompt || !window.lavish?.sendQueuedPrompts) return status('Open with lavish-axi to send feedback.');
  const batch = structuredClone(sortNotes(notes));
  const response = [...reactions.values()];
  sent = true;
  closeComposer();
  renderNotes();
  renderHistory();
  try {
    await window.lavish.queuePrompt(feedbackPrompt(version, batch, response), { tag: 'video-review',
      text: `${batch.length} note(s), ${response.length} reaction(s) for ${version}`, queueKey: `region-review-${version}`,
      data: { schema_version: 3, version, composition: 'composition/index.html',
        width, height, fps, frame_count: frameCount, reviewer, reactions: response, notes: batch,
        transcript_edits: transcriptEdits, overlay_position: overlayPosition } });
    const result = await window.lavish.sendQueuedPrompts();
    if (result === false || result?.ok === false) throw new Error('Lavish rejected this batch');
    if (!locked) status('Submitted to Lavish. Waiting for the agent’s poll to lock this round.');
  } catch {
    sent = false;
    status('Could not send. Notes are still here. Try again.');
    renderNotes();
    renderHistory();
  }
};

iframe.addEventListener('load', () => {
  const channel = new MessageChannel();
  port = channel.port1;
  const timer = setTimeout(() => status('Cannot load live review: no response from the composition.'), 8500);
  port.onmessage = ({ data }) => {
    if (data.kind === 'seek-error') {
      return status(data.message);
    }
    if (data.kind === 'playback') {
      if (data.request !== request) return;
      playing = data.playing;
      $('#play').textContent = playing ? 'Pause' : 'Play';
      showFrame(data.frame);
      if (!playing) seekFrame(data.frame);
      return;
    }
    if (data.kind === 'positioned') {
      if (data.request !== request) return;
      positioned = true;
      if (draft?.rect && data.targets) {
        draft.targets = data.targets;
        draft.footage = data.footage.map(anchor => ({
          ...mapInterval(edl, assets, data.frame, data.frame + 1).find(span => span.clip === anchor.clip),
          ...anchor,
        }));
        $('#targets').textContent = [
          ...draft.targets.map(target => target.selector),
          ...draft.footage.map(anchor => `${anchor.clip} · source F${anchor.source_frame}`),
        ].join(', ') || 'Background region';
        composer.querySelector('[type=submit]').disabled = false;
        placeComposer();
      }
      return;
    }
    clearTimeout(timer);
    if (data.kind === 'error') return status(`Cannot load live review: ${data.message}`);
    if (data.kind !== 'ready') return;
    ({ width, height, fps, frameCount } = data);
    if (frameCount !== edl.frame_count || fps !== edl.fps) return status('Composition timing differs from its EDL.');
    ready = true;
    canvas.style.width = `min(100%, ${Math.min(width, 560 * width / height)}px)`;
    canvas.style.aspectRatio = `${width} / ${height}`;
    Object.assign(iframe.style, { width: `${width}px`, height: `${height}px` });
    resize();
    seek.max = frameCount - 1;
    $('#range-start').max = frameCount - 1;
    $('#range-end').max = frameCount;
    timeline.hidden = false;
    for (const selector of ['#play', '#previous', '#next', '#seek', '#range-start', '#range-end']) $(selector).disabled = false;
    seekFrame(initialPosition());
    renderTranscript();
    renderNotes();
    renderHistory();
    status(locked ? 'Feedback locked. This round is read-only.' : 'Ready. Select a region, drag a range, or add a whole-video note.');
  };
  iframe.contentWindow.postMessage('frame-review:connect', '*', [channel.port2]);
}, { once: true });
new ResizeObserver(resize).observe(canvas);
new ResizeObserver(() => { if (ready) positionPlayhead(); }).observe(timeline);
window.addEventListener('scroll', placeComposer, { passive: true });
window.addEventListener('resize', placeComposer);
iframe.srcdoc = config.liveComposition;
