import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decode } from '@toon-format/toon';
import { lockNotes } from './notes.mjs';

const chrome = process.env.DAILIES_LAVISH_TEST_CHROME;
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));

async function waitFor(check) {
  const deadline = Date.now() + 15000;
  do {
    const value = await check();
    if (value) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for Chrome review');
}

async function connect(target) {
  const socket = new WebSocket(target);
  await once(socket, 'open');
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const { id, result, error } = JSON.parse(data);
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) request.reject(new Error(error.message));
    else request.resolve(result);
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const evaluate = async (expression, contextId, sessionId) => {
    const response = await call('Runtime.evaluate', { contextId, expression, returnByValue: true }, sessionId);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description);
    return response.result.value;
  };
  return { call, evaluate, close: () => socket.close() };
}

test('Lavish review supports trusted Shift-click, inline edits and anchored notes without layout shift', {
  skip: !chrome, timeout: 60000,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-lavish-browser-'));
  const env = { ...process.env, LAVISH_AXI_HOST: '127.0.0.1', CHROME_DEVTOOLS_AXI_AUTO_CONNECT: '0',
    CHROME_DEVTOOLS_AXI_SESSION: `dailies-review-${process.pid}-${Date.now()}` };
  const workspace = join(dir, 'workspace'), proxy = join(dir, 'rough.mp4');
  const folder = join(workspace, 'review', 'v1'), review = join(folder, 'review.html');
  const srt = join(dir, 'two.srt'), profile = join(dir, 'chrome');
  let browser, session, published = false;
  t.after(async () => {
    session?.close();
    if (published) await exec('lavish-axi', ['end', review], { env }).catch(() => {});
    await exec('chrome-devtools-axi', ['stop'], { env }).catch(() => {});
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const closed = once(browser, 'exit');
      browser.kill();
      await closed;
    }
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(srt, '1\n00:00:01,000 --> 00:00:02,000\nFirst line.\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line.\n');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=5',
    '-c:v', 'libx264', proxy], { env });
  const build = await exec(process.execPath, [cli, 'open', proxy, workspace, '--brief', 'Synthetic browser test',
    '--srt', srt, '--no-poll'], { env });
  const url = decode(build.stdout).session.url;
  published = true;
  browser = spawn(chrome, ['--headless', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1100,960', 'about:blank'], { env, stdio: 'ignore' });
  const port = await waitFor(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')
    .catch(error => { if (error.code !== 'ENOENT') throw error; }))?.split('\n')[0]);
  env.CHROME_DEVTOOLS_AXI_BROWSER_URL = `http://127.0.0.1:${port}`;
  await exec('chrome-devtools-axi', ['open', url], { env });
  const targets = await (await fetch(`${env.CHROME_DEVTOOLS_AXI_BROWSER_URL}/json/list`)).json();
  const target = targets.find(page => page.type === 'page' && page.url === url);
  assert.ok(target, 'Chrome DevTools found the isolated Lavish tab');
  session = await connect(target.webSocketDebuggerUrl);

  async function reviewContext() {
    const artifact = await waitFor(async () => {
      const { root } = await session.call('DOM.getDocument');
      const { nodeId } = await session.call('DOM.querySelector', { nodeId: root.nodeId, selector: '#artifact' });
      if (!nodeId) return;
      return (await session.call('DOM.describeNode', { nodeId })).node.frameId;
    });
    const { targetInfos } = await session.call('Target.getTargets');
    if (targetInfos.some(target => target.type === 'iframe' && target.targetId === artifact)) {
      const { sessionId } = await session.call('Target.attachToTarget', { targetId: artifact, flatten: true });
      return expression => session.evaluate(expression, undefined, sessionId);
    }
    const { executionContextId } = await session.call('Page.createIsolatedWorld', {
      frameId: artifact, worldName: 'dailies-review-test',
    });
    return expression => session.evaluate(expression, executionContextId);
  }

  async function pressClick(evaluate, selector, modifiers = 0) {
    const [x, y] = await evaluate(`(() => {
      window.lastClick = undefined;
      const button = document.querySelector(${JSON.stringify(selector)});
      button.addEventListener('click', e => { window.lastClick = { trusted: e.isTrusted, shift: e.shiftKey }; }, { once:true });
      button.scrollIntoView({ block: 'center', inline: 'nearest' });
      const bounds = button.getBoundingClientRect();
      return [bounds.x + 12, bounds.y + bounds.height / 2];
    })()`);
    const [left, top] = await session.evaluate(`(() => {
      const r = document.querySelector('#artifact').getBoundingClientRect();
      return [r.left, r.top];
    })()`);
    const hit = await session.evaluate(`document.elementFromPoint(${left + x}, ${top + y})?.id`);
    assert.equal(hit, 'artifact', 'click is inside the visible Lavish artifact');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.call('Input.dispatchMouseEvent', { type, x: left + x, y: top + y,
        button: 'left', buttons: type === 'mousePressed' ? 1 : 0, modifiers, clickCount: 1 });
    }
    assert.deepEqual(await waitFor(() => evaluate('window.lastClick')), { trusted: true, shift: modifiers === 8 });
  }

  const bounds = '(Array.from(document.querySelectorAll("#range-start,#range-end"), el => +el.value))';
  const evaluate = await reviewContext();
  await waitFor(() => evaluate('document.querySelector("#whole").disabled === false'));
  await waitFor(() => session.evaluate('document.querySelector("#layoutGateOverlay").hidden'));
  await evaluate(`(() => {
    window.shifts = [];
    const observer = new PerformanceObserver(list => window.shifts.push(...list.getEntries().map(e => e.value)));
    observer.observe({type: 'layout-shift'});
    window.layoutObserver = observer;
  })()`);
  assert.deepEqual(await evaluate(`(() => {
    const button = document.querySelector('#send');
    return [button.disabled, button.getAttribute('aria-disabled'), getComputedStyle(button).backgroundColor];
  })()`), [true, 'true', 'rgb(53, 50, 64)'], 'empty feedback is disabled and grey');

  await pressClick(evaluate, '.transcript-line:nth-child(1) .cue-text', 8);
  assert.deepEqual(await evaluate(bounds), [10, 20], 'one cue is selected in an open review');
  await pressClick(evaluate, '.transcript-line:nth-child(2) .cue-text', 8);
  assert.deepEqual(await evaluate(bounds), [10, 40], 'a second cue extends the selected range');

  for (const selector of ['#add-range', '#whole']) {
    await pressClick(evaluate, selector);
    assert.ok(await evaluate(`(() => {
      const popover = document.querySelector('#composer').getBoundingClientRect();
      const button = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      const gap = Math.min(Math.abs(popover.top - button.bottom), Math.abs(popover.bottom - button.top));
      return gap >= 7 && gap <= 9 && popover.left >= 0 && popover.top >= 0 &&
        popover.right <= innerWidth && popover.bottom <= innerHeight && document.activeElement.id === 'feedback';
    })()`), `note editor is adjacent to ${selector} and fits the viewport`);
    await session.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await session.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    assert.ok(await evaluate(`document.querySelector('#composer').hidden && document.activeElement.matches('${selector}')`),
      'Escape closes the editor and restores focus to the button');
  }

  const edit = '.transcript-line:nth-child(1) .cue-edit';
  await pressClick(evaluate, edit);
  assert.equal(await evaluate(`document.querySelector('${edit}').textContent`), 'Done');
  await session.call('Input.insertText', { text: 'Correct first line.' });
  await pressClick(evaluate, edit);
  assert.deepEqual(await evaluate(`(() => {
    const row = document.querySelector('.transcript-line');
    const send = document.querySelector('#send');
    return [row.querySelector('.cue-edit').textContent, row.classList.contains('edited'),
      row.querySelector('.cue-text').textContent, send.disabled, send.getAttribute('aria-disabled')];
  })()`), ['Edit', true, 'Correct first line.', false, 'false'], 'Done saves; a pending correction can be sent by itself');

  await lockNotes(folder, 'v1', {
    schema_version: 3, version: 'v1',
    notes: [{ id: 'N1', kind: 'general', text: 'Synthetic review note', frame: 0, end_frame: 50, whole_video: true }],
  });
  await waitFor(() => evaluate('document.querySelector("#status").textContent.includes("read-only")'));
  await pressClick(evaluate, '.transcript-line:nth-child(1) .cue-text', 8);
  assert.deepEqual(await evaluate(bounds), [10, 20], 'selection works independently of feedback locking');
  await delay(650);
  const shifts = await evaluate('window.shifts');
  t.diagnostic(`Layout shift entries: ${shifts.length}; cumulative value: ${shifts.reduce((sum, shift) => sum + shift, 0)}`);
  assert.deepEqual(shifts, []);
});
