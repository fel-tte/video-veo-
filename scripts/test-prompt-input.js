/**
 * Debug prompt input — the placeholder "What do you want to create?"
 * might need special handling. Also check if Create button state changes.
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
  await sleep(500);

  // Inspect the contenteditable field deeply
  console.log('=== Inspecting prompt input ===');
  const ceInfo = await evalJS(ws, `
    JSON.stringify((function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return { found: false };
      const r = ce.getBoundingClientRect();
      return {
        found: true,
        textContent: ce.textContent?.substring(0, 100),
        innerText: ce.innerText?.substring(0, 100),
        innerHTML: ce.innerHTML?.substring(0, 300),
        childNodes: ce.childNodes.length,
        children: Array.from(ce.children).map(c => ({
          tag: c.tagName, class: (c.className||'').substring(0,60),
          text: c.textContent?.substring(0,60),
          contenteditable: c.getAttribute('contenteditable'),
          ariaHidden: c.getAttribute('aria-hidden'),
          dataPlaceholder: c.getAttribute('data-placeholder')
        })),
        placeholder: ce.getAttribute('data-placeholder') || ce.getAttribute('placeholder'),
        ariaLabel: ce.getAttribute('aria-label'),
        ariaPlaceholder: ce.getAttribute('aria-placeholder'),
        left: Math.round(r.left), top: Math.round(r.top),
        right: Math.round(r.right), bottom: Math.round(r.bottom)
      };
    })())
  `);
  console.log(JSON.stringify(JSON.parse(ceInfo), null, 2));

  // Check all contenteditable elements
  console.log('\n=== All contenteditable elements ===');
  const allCE = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('[contenteditable="true"]'))
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName, text: el.textContent?.substring(0,60),
            innerHTML: el.innerHTML?.substring(0,100),
            visible: r.width > 0,
            x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)
          };
        })
    )
  `);
  console.log(allCE);

  // Try: Click on the contenteditable to focus, then type via CDP Input.insertText
  console.log('\n=== Strategy: CDP click + CDP Input.insertText ===');

  // First click on contenteditable area
  const ceData = JSON.parse(ceInfo);
  if (ceData.found) {
    const ceX = Math.round((ceData.left + ceData.right) / 2);
    const ceY = Math.round((ceData.top + ceData.bottom) / 2);
    console.log(`Clicking contenteditable at (${ceX}, ${ceY})`);
    await cdpClick(ws, ceX, ceY);
    await sleep(500);

    // Clear existing content with Ctrl+A then Delete
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }); // Ctrl+A
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await sleep(200);
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(500);

    // Check if content cleared
    const afterClear = await evalJS(ws, `document.querySelector("div[contenteditable='true']")?.textContent`);
    console.log('After clear:', JSON.stringify(afterClear));

    // Type using CDP Input.insertText (this simulates real keyboard input)
    const prompt = 'A tiny robot reading a book in a rainy cafe, cyberpunk vibes';
    console.log(`Typing via CDP: "${prompt.substring(0, 40)}..."`);
    await sendCDP(ws, 'Input.insertText', { text: prompt });
    await sleep(1000);

    // Check content
    const afterType = await evalJS(ws, `document.querySelector("div[contenteditable='true']")?.textContent`);
    console.log('After type:', JSON.stringify(afterType?.substring(0, 80)));

    // Check innerHTML for actual input structure
    const afterHTML = await evalJS(ws, `document.querySelector("div[contenteditable='true']")?.innerHTML?.substring(0, 200)`);
    console.log('innerHTML:', afterHTML);

    // Now check Create button state
    const createState = await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if (t.includes('arrow_forward') && t.includes('Create')) {
            return JSON.stringify({
              text: t, disabled: b.disabled,
              ariaDisabled: b.getAttribute('aria-disabled'),
              class: (b.className||'').substring(0,80),
              opacity: getComputedStyle(b).opacity,
              pointerEvents: getComputedStyle(b).pointerEvents,
              cursor: getComputedStyle(b).cursor
            });
          }
        }
        return null;
      })()
    `);
    console.log('\nCreate button state:', createState);

    // Click Create
    console.log('\nClicking Create...');
    const createPos = await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if (t.includes('arrow_forward') && t.includes('Create') && b.getBoundingClientRect().width > 0) {
            const r = b.getBoundingClientRect();
            return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
          }
        }
        return null;
      })()
    `);
    if (createPos) {
      const pos = JSON.parse(createPos);
      await cdpClick(ws, pos.x, pos.y);
      await sleep(5000);
      const count = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
      console.log(`Media count after CDP Create click: ${count}`);

      // Also check URL — maybe it navigated
      const newUrl = await evalJS(ws, 'window.location.href');
      console.log('URL:', newUrl);
    }
  }

  ws.close();
  console.log('\nDone');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
