/**
 * Try CDP mouse events with proper focus sequence:
 * 1. Click somewhere neutral first (ensure page has focus)
 * 2. Move mouse to button
 * 3. Full mousedown/mouseup/click sequence
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

// Full CDP mouse click with move + hover + press + release
async function fullCDPClick(ws, x, y, label) {
  console.log(`  CDP click "${label}" at (${x}, ${y})`);
  // Move mouse there first
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(200);
  // Press
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(100);
  // Release
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function checkMenuState(ws) {
  return await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) {
          return JSON.stringify({
            dataState: b.getAttribute('data-state'),
            ariaExpanded: b.getAttribute('aria-expanded'),
            menuItems: document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]').length,
            radixPoppers: document.querySelectorAll('[data-radix-popper-content-wrapper]').length,
            openElements: document.querySelectorAll('[data-state="open"]').length
          });
        }
      }
      return '{}';
    })()
  `);
}

async function main() {
  const pages = await getPages();
  let flowPage = pages.find(p => p.url.includes('flow/project') && !p.url.includes('/edit/'));
  if (!flowPage) flowPage = pages.find(p => p.url.includes('flow/project'));
  if (!flowPage) { console.error('No Flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  const url = await evalJS(ws, 'window.location.href');
  console.log('URL:', url);

  if (url.includes('/edit/')) {
    await sendCDP(ws, 'Page.navigate', { url: url.split('/edit/')[0] });
    await sleep(4000);
  }

  // Bring page focus: click in neutral area first
  console.log('\n--- Step 1: Focus page ---');
  await fullCDPClick(ws, 640, 400, 'neutral area');
  await sleep(500);

  // Get button coordinates
  const btnPos = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({
            text: t.substring(0,60), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
            left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom),
            width: Math.round(r.width), height: Math.round(r.height)
          });
        }
      }
      return null;
    })()
  `);
  const btn = JSON.parse(btnPos);
  console.log('Button:', btn);

  // Attempt 1: Click center of button
  console.log('\n--- Attempt 1: Click button center ---');
  await fullCDPClick(ws, btn.x, btn.y, 'settings btn');
  await sleep(2000);
  let state = JSON.parse(await checkMenuState(ws));
  console.log('State:', state);

  if (state.dataState !== 'open' && state.menuItems === 0) {
    // Attempt 2: Click slightly left of center (avoid icon area)
    console.log('\n--- Attempt 2: Click left part of button ---');
    await fullCDPClick(ws, btn.left + 20, btn.y, 'settings btn left');
    await sleep(2000);
    state = JSON.parse(await checkMenuState(ws));
    console.log('State:', state);
  }

  if (state.dataState !== 'open' && state.menuItems === 0) {
    // Attempt 3: Click the text area specifically
    console.log('\n--- Attempt 3: Click text area ---');
    await fullCDPClick(ws, btn.left + btn.width * 0.3, btn.y, 'settings text area');
    await sleep(2000);
    state = JSON.parse(await checkMenuState(ws));
    console.log('State:', state);
  }

  if (state.dataState !== 'open' && state.menuItems === 0) {
    // Attempt 4: Try the actual Wails app browser window might be offset
    // Check if there's a difference between page coordinates and screen coordinates
    console.log('\n--- Attempt 4: Check coordinate system ---');
    const coordCheck = await evalJS(ws, `
      JSON.stringify({
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        screenX: window.screenX,
        screenY: window.screenY,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      })
    `);
    console.log('Coordinates:', coordCheck);

    // Also try: activate page first
    console.log('\n--- Attempt 5: Page.bringToFront + click ---');
    try {
      await sendCDP(ws, 'Page.bringToFront');
    } catch (e) { console.log('bringToFront error:', e.message); }
    await sleep(500);
    await fullCDPClick(ws, btn.x, btn.y, 'settings btn after bringToFront');
    await sleep(2000);
    state = JSON.parse(await checkMenuState(ws));
    console.log('State:', state);
  }

  if (state.dataState === 'open' || state.menuItems > 0 || state.radixPoppers > 0) {
    console.log('\n=== MENU OPENED! ===');
    // Get menu items
    const items = await evalJS(ws, `
      JSON.stringify(
        Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], [data-radix-collection-item]'))
          .filter(el => el.getBoundingClientRect().width > 0)
          .map(el => ({
            role: el.getAttribute('role'),
            text: el.textContent?.trim()?.substring(0, 80),
            state: el.getAttribute('data-state') || el.getAttribute('aria-checked') || '',
            x: Math.round(el.getBoundingClientRect().x + el.getBoundingClientRect().width/2),
            y: Math.round(el.getBoundingClientRect().y + el.getBoundingClientRect().height/2)
          }))
      )
    `);
    JSON.parse(items).forEach(i => console.log(`  [${i.state}] "${i.text}" at (${i.x}, ${i.y})`));
  } else {
    console.log('\n=== MENU DID NOT OPEN - taking screenshot ===');
    const screenshot = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync('c:/Users/Admin/Desktop/veo3/scripts/debug-screenshot.png', Buffer.from(screenshot.data, 'base64'));
    console.log('Screenshot saved');
  }

  ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
