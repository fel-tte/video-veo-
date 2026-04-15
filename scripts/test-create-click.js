/**
 * Focus on making the Create button actually work:
 * 1. Clear any focus/state issues
 * 2. Type prompt
 * 3. Click Create button precisely
 * 4. Verify generation started
 */
const WebSocket = require('ws');
const http = require('http');

const CDP_PORT = 9222;

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
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
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
  let flowPage = pages.find(p => p.url.includes('flow/project') && !p.url.includes('/edit/'));
  if (!flowPage) flowPage = pages.find(p => p.url.includes('flow/project'));
  if (!flowPage) { console.error('No Flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  let url = await evalJS(ws, 'window.location.href');
  if (url.includes('/edit/')) {
    await sendCDP(ws, 'Page.navigate', { url: url.split('/edit/')[0] });
    await sleep(5000);
  }
  try { await sendCDP(ws, 'Page.bringToFront'); } catch(e) {}
  await sleep(1000);

  const initialCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  console.log('Initial media count:', initialCount);

  // Step 1: Clear prompt and type new one
  console.log('\n--- Step 1: Type prompt ---');
  await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return;
      ce.click(); ce.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ce);
      sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('insertText', false, 'A tiny robot reading a book in a rainy cafe, cyberpunk, neon lights');
    })()
  `);
  await sleep(500);
  const promptText = await evalJS(ws, `document.querySelector("div[contenteditable='true']")?.textContent`);
  console.log('Prompt:', promptText?.substring(0, 60));

  // Step 2: Find Create button precisely
  console.log('\n--- Step 2: Find Create button ---');
  const createBtnInfo = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('arrow_forward') && t.includes('Create') && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          // Get the EXACT center - this is a small icon button
          return JSON.stringify({
            text: t, cx: r.x + r.width/2, cy: r.y + r.height/2,
            left: r.left, top: r.top, right: r.right, bottom: r.bottom,
            width: r.width, height: r.height,
            tagName: b.tagName, disabled: b.disabled,
            parentTag: b.parentElement?.tagName,
            parentText: (b.parentElement?.textContent?.trim()||'').substring(0,80)
          });
        }
      }
      return null;
    })()
  `);
  console.log('Create button:', createBtnInfo);

  if (!createBtnInfo) {
    console.error('Create button not found!');
    ws.close(); return;
  }

  const btn = JSON.parse(createBtnInfo);

  // Strategy A: CDP click at exact center
  console.log(`\n--- Strategy A: CDP click at (${Math.round(btn.cx)}, ${Math.round(btn.cy)}) ---`);
  await cdpClick(ws, Math.round(btn.cx), Math.round(btn.cy));
  await sleep(5000);
  let count = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  console.log(`Media count: ${count} (was ${initialCount})`);

  if (count <= initialCount) {
    // Strategy B: JS click()
    console.log('\n--- Strategy B: JS click() ---');
    // Re-type prompt since Strategy A may have cleared focus
    await evalJS(ws, `
      (function(){
        const ce = document.querySelector("div[contenteditable='true']");
        if (ce) { ce.click(); ce.focus(); }
      })()
    `);
    await sleep(500);

    await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if (t.includes('arrow_forward') && t.includes('Create') && b.getBoundingClientRect().width > 0) {
            b.click();
            return 'clicked';
          }
        }
        return 'not found';
      })()
    `);
    await sleep(5000);
    count = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
    console.log(`Media count: ${count}`);
  }

  if (count <= initialCount) {
    // Strategy C: Synthetic events like settings dropdown
    console.log('\n--- Strategy C: Synthetic pointer events ---');
    await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if (t.includes('arrow_forward') && t.includes('Create') && b.getBoundingClientRect().width > 0) {
            const r = b.getBoundingClientRect();
            const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, button: 0 };
            b.dispatchEvent(new PointerEvent('pointerdown', opts));
            b.dispatchEvent(new MouseEvent('mousedown', opts));
            b.dispatchEvent(new PointerEvent('pointerup', opts));
            b.dispatchEvent(new MouseEvent('mouseup', opts));
            b.dispatchEvent(new MouseEvent('click', opts));
            return 'dispatched';
          }
        }
        return 'not found';
      })()
    `);
    await sleep(5000);
    count = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
    console.log(`Media count: ${count}`);
  }

  if (count <= initialCount) {
    // Strategy D: Enter key while prompt is focused
    console.log('\n--- Strategy D: Enter key from prompt ---');
    await evalJS(ws, `
      (function(){
        const ce = document.querySelector("div[contenteditable='true']");
        if (ce) { ce.click(); ce.focus(); }
      })()
    `);
    await sleep(300);
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(5000);
    count = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
    console.log(`Media count: ${count}`);
  }

  if (count > initialCount) {
    console.log(`\n=== SUCCESS: Generation started! +${count - initialCount} new items ===`);
  } else {
    console.log('\n=== ALL STRATEGIES FAILED ===');
    // Check prompt content — maybe it was consumed?
    const remaining = await evalJS(ws, `document.querySelector("div[contenteditable='true']")?.textContent`);
    console.log('Prompt remaining:', remaining?.substring(0, 80));

    // Check if we're now on a different page
    const newUrl = await evalJS(ws, 'window.location.href');
    console.log('URL:', newUrl);
  }

  ws.close();
  console.log('\nDone');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
