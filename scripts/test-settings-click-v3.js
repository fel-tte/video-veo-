/**
 * Debug: try multiple click strategies on the settings button
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

async function cdpClick(ws, x, y) {
  // Move first, then press, then release
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(100);
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(50);
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const pages = await getPages();
  let flowPage = pages.find(p => p.url.includes('flow/project') && !p.url.includes('/edit/'));
  if (!flowPage) flowPage = pages.find(p => p.url.includes('flow/project'));
  if (!flowPage) { console.error('No Flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  let url = await evalJS(ws, 'window.location.href');
  console.log('URL:', url);

  if (url.includes('/edit/')) {
    await sendCDP(ws, 'Page.navigate', { url: url.split('/edit/')[0] });
    await sleep(4000);
  }

  // Enable DOM domain
  await sendCDP(ws, 'DOM.enable');

  // Get window/viewport info
  const viewport = await evalJS(ws, `JSON.stringify({
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    scrollY: window.scrollY,
    devicePixelRatio: window.devicePixelRatio
  })`);
  console.log('Viewport:', viewport);

  // Scroll to bottom to ensure settings button is visible
  await evalJS(ws, 'window.scrollTo(0, document.body.scrollHeight)');
  await sleep(1000);

  // Get button position AFTER scroll
  const btnInfo = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) {
          const r = b.getBoundingClientRect();
          // Also scroll into view
          b.scrollIntoView({ block: 'center' });
          const r2 = b.getBoundingClientRect();
          return JSON.stringify({
            text: t.substring(0,80),
            before: { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), top: Math.round(r.top), bot: Math.round(r.bottom) },
            after: { x: Math.round(r2.x + r2.width/2), y: Math.round(r2.y + r2.height/2), top: Math.round(r2.top), bot: Math.round(r2.bottom) },
            inViewport: r2.top >= 0 && r2.bottom <= window.innerHeight,
            hasPopup: b.getAttribute('aria-haspopup'),
            dataState: b.getAttribute('data-state')
          });
        }
      }
      return null;
    })()
  `);
  const bi = JSON.parse(btnInfo);
  console.log('\nButton info:', JSON.stringify(bi, null, 2));

  // Strategy 1: CDP click with precise coords after scrollIntoView
  console.log('\n--- Strategy 1: CDP click after scrollIntoView ---');
  await cdpClick(ws, bi.after.x, bi.after.y);
  await sleep(1500);

  let state = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) return b.getAttribute('data-state');
      }
      return 'not found';
    })()
  `);
  console.log('data-state:', state);

  if (state !== 'open') {
    // Strategy 2: Use DOM.querySelector + DOM.getBoxModel for exact position
    console.log('\n--- Strategy 2: DOM.getBoxModel ---');

    // Find via JS, get node ID
    const nodeResult = await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) {
            b.setAttribute('data-test-settings', 'true');
            return 'marked';
          }
        }
        return 'not found';
      })()
    `);
    console.log('Marked button:', nodeResult);

    const doc = await sendCDP(ws, 'DOM.getDocument');
    const node = await sendCDP(ws, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: '[data-test-settings="true"]'
    });
    console.log('Node ID:', node.nodeId);

    if (node.nodeId) {
      const box = await sendCDP(ws, 'DOM.getBoxModel', { nodeId: node.nodeId });
      if (box && box.model) {
        const content = box.model.content;
        // content is [x1,y1, x2,y2, x3,y3, x4,y4] — center of quad
        const cx = Math.round((content[0] + content[2] + content[4] + content[6]) / 4);
        const cy = Math.round((content[1] + content[3] + content[5] + content[7]) / 4);
        console.log(`BoxModel center: (${cx}, ${cy})`);

        await cdpClick(ws, cx, cy);
        await sleep(1500);

        state = await evalJS(ws, `
          (function(){
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
              const t = b.textContent?.trim() || '';
              if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) return b.getAttribute('data-state');
            }
            return 'not found';
          })()
        `);
        console.log('data-state:', state);
      }
    }
  }

  if (state !== 'open') {
    // Strategy 3: Focus + Enter key
    console.log('\n--- Strategy 3: Focus + Enter ---');
    await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) {
            b.focus();
            return 'focused';
          }
        }
        return 'not found';
      })()
    `);
    await sleep(300);
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(1500);

    state = await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) return b.getAttribute('data-state');
        }
        return 'not found';
      })()
    `);
    console.log('data-state:', state);
  }

  if (state !== 'open') {
    // Strategy 4: dispatchEvent pointerdown + pointerup + click
    console.log('\n--- Strategy 4: Synthetic pointer events ---');
    await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) {
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
    await sleep(1500);

    state = await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) return b.getAttribute('data-state');
        }
        return 'not found';
      })()
    `);
    console.log('data-state:', state);
  }

  // Check what happened
  if (state === 'open') {
    console.log('\n=== MENU OPENED! Getting items ===');
    const items = await evalJS(ws, `
      JSON.stringify(
        Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]'))
          .filter(el => el.getBoundingClientRect().width > 0)
          .map(el => ({
            role: el.getAttribute('role'),
            text: el.textContent?.trim()?.substring(0, 80),
            state: el.getAttribute('data-state') || el.getAttribute('aria-checked') || ''
          }))
      )
    `);
    const parsed = JSON.parse(items);
    parsed.forEach(i => console.log(`  [${i.state}] ${i.role}: "${i.text}"`));
  } else {
    console.log('\n=== FAILED to open menu with all strategies ===');

    // Take screenshot for debugging
    const screenshot = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png' });
    const fs = require('fs');
    fs.writeFileSync('c:/Users/Admin/Desktop/veo3/scripts/debug-screenshot.png', Buffer.from(screenshot.data, 'base64'));
    console.log('Screenshot saved to scripts/debug-screenshot.png');
  }

  // Cleanup
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
