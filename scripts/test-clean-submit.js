/**
 * Clean test: Refresh page, wait for load, type via CDP, click Create
 */
const WebSocket = require('ws');
const http = require('http');

const CDP_PORT = 9222;
const PROMPT = 'A sunset over the ocean waves, cinematic';

async function getPages() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function sendCDP(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 100000);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
    const handler = (msg) => {
      const data = JSON.parse(msg);
      if (data.id === id) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function connectToPage(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function evalJS(ws, expression) {
  const { result } = await sendCDP(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  });
  if (result.subtype === 'error') throw new Error(result.description);
  return result.value;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function cdpClick(ws, x, y) {
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(100);
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(50);
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function main() {
  const pages = await getPages();
  let flowPage = pages.find(p => p.url.includes('flow/project'));
  if (!flowPage) { console.error('No Flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  try { await sendCDP(ws, 'Page.bringToFront'); } catch(e) {}

  // Reload the page
  console.log('Reloading page...');
  await sendCDP(ws, 'Page.reload');
  await sleep(8000);

  const url = await evalJS(ws, 'window.location.href');
  console.log('URL:', url);

  // Wait for contenteditable to appear
  console.log('Waiting for editor...');
  let editorFound = false;
  for (let i = 0; i < 10; i++) {
    const found = await evalJS(ws, `!!document.querySelector("div[contenteditable='true']")`);
    if (found) { editorFound = true; break; }
    await sleep(2000);
  }
  if (!editorFound) { console.error('Editor not found after 20s'); ws.close(); return; }

  const initialCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  console.log('Initial media:', initialCount);

  // Check the editor state - is it empty/has placeholder?
  const editorState = await evalJS(ws, `
    JSON.stringify((function(){
      const ce = document.querySelector("div[contenteditable='true']");
      const placeholder = ce.querySelector('[data-slate-placeholder]');
      const r = ce.getBoundingClientRect();
      return {
        hasPlaceholder: !!placeholder,
        textContent: ce.textContent?.substring(0, 80),
        x: Math.round(r.left + 10),
        y: Math.round(r.top + r.height/2),
        width: Math.round(r.width),
        height: Math.round(r.height)
      };
    })())
  `);
  console.log('Editor:', editorState);
  const editor = JSON.parse(editorState);

  // Click editor to focus
  console.log(`\nClicking editor at (${editor.x}, ${editor.y})`);
  await cdpClick(ws, editor.x, editor.y);
  await sleep(500);

  // Type using Input.insertText (this is how CDP simulates real typing in Slate)
  console.log(`Typing: "${PROMPT}"`);
  await sendCDP(ws, 'Input.insertText', { text: PROMPT });
  await sleep(1000);

  // Check what was typed
  const typed = await evalJS(ws, `
    JSON.stringify((function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return { error: 'no editor' };
      const placeholder = ce.querySelector('[data-slate-placeholder]');
      return {
        text: ce.textContent?.substring(0, 80),
        hasPlaceholder: !!placeholder,
        innerText: ce.innerText?.substring(0, 80)
      };
    })())
  `);
  console.log('After typing:', typed);

  // Check all buttons
  console.log('\nAll bottom buttons:');
  const btns = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('button'))
        .filter(b => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().y > 680)
        .map(b => {
          const r = b.getBoundingClientRect();
          return {
            text: (b.textContent?.trim()||'').substring(0, 60),
            x: Math.round(r.x + r.width/2),
            y: Math.round(r.y + r.height/2),
            disabled: b.disabled,
            popup: b.getAttribute('aria-haspopup')
          };
        })
    )
  `);
  JSON.parse(btns).forEach(b => console.log(`  "${b.text}" at (${b.x},${b.y}) disabled=${b.disabled} popup=${b.popup}`));

  // Click Create
  const createPos = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('arrow_forward') && t.includes('Create') && b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().y > 680) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
        }
      }
      return null;
    })()
  `);

  if (createPos) {
    const pos = JSON.parse(createPos);
    console.log(`\nClicking Create at (${pos.x}, ${pos.y})...`);
    await cdpClick(ws, pos.x, pos.y);
    await sleep(8000);

    const newCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
    console.log(`Media count: ${newCount} (was ${initialCount})`);

    if (newCount > initialCount) {
      console.log('=== SUCCESS! ===');
    } else {
      // Check if page changed
      const newUrl = await evalJS(ws, 'window.location.href');
      console.log('URL:', newUrl);

      // Check for any error messages
      const errors = await evalJS(ws, `
        JSON.stringify(
          Array.from(document.querySelectorAll('[role="alert"], [class*="error"], [class*="snackbar"]'))
            .filter(el => el.getBoundingClientRect().width > 0)
            .map(el => el.textContent?.trim()?.substring(0, 100))
        )
      `);
      console.log('Errors:', errors);

      // Check editor state again
      const finalEditor = await evalJS(ws, `
        (function(){
          const ce = document.querySelector("div[contenteditable='true']");
          return ce ? ce.textContent?.substring(0, 80) : 'editor gone';
        })()
      `);
      console.log('Editor content:', finalEditor);
    }
  } else {
    console.log('\nCreate button not found!');
  }

  ws.close();
  console.log('\nDone');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
