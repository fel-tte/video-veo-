/**
 * Open the settings dropdown and inspect the actual DOM inside the Radix popper
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

async function fullCDPClick(ws, x, y) {
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(150);
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(80);
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function main() {
  const pages = await getPages();
  let flowPage = pages.find(p => p.url.includes('flow/project'));
  if (!flowPage) { console.error('No Flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  let url = await evalJS(ws, 'window.location.href');

  // Go to project page
  if (url.includes('/edit/')) {
    await sendCDP(ws, 'Page.navigate', { url: url.split('/edit/')[0] });
    await sleep(5000);
  }

  try { await sendCDP(ws, 'Page.bringToFront'); } catch(e) {}
  await sleep(500);

  // Find & click settings button
  const btnPos = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_') && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
        }
      }
      return null;
    })()
  `);

  if (!btnPos) { console.error('No settings button'); ws.close(); return; }
  const { x, y } = JSON.parse(btnPos);
  console.log(`Clicking settings at (${x}, ${y})...`);
  await fullCDPClick(ws, x, y);
  await sleep(2000);

  // Inspect the Radix popper content
  const popperDOM = await evalJS(ws, `
    JSON.stringify((function(){
      const popper = document.querySelector('[data-radix-popper-content-wrapper]');
      if (!popper) return { found: false };

      // Get all clickable elements inside
      const result = {
        found: true,
        innerHTML: popper.innerHTML.substring(0, 3000),
        children: []
      };

      // Walk all child elements
      function walk(el, depth) {
        if (depth > 5) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;

        const info = {
          tag: el.tagName,
          role: el.getAttribute('role'),
          text: (el.textContent?.trim() || '').substring(0, 60),
          dataState: el.getAttribute('data-state'),
          ariaChecked: el.getAttribute('aria-checked'),
          ariaSelected: el.getAttribute('aria-selected'),
          className: (el.className || '').substring(0, 80),
          x: Math.round(r.x + r.width/2),
          y: Math.round(r.y + r.height/2),
          w: Math.round(r.width),
          h: Math.round(r.height),
          clickable: el.tagName === 'BUTTON' || el.getAttribute('role') === 'menuitem' || el.getAttribute('role') === 'menuitemradio' || el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'option' || el.onclick !== null
        };

        // Only add leaf-ish nodes (with short text)
        const directText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        if (directText || el.tagName === 'BUTTON' || el.getAttribute('role')) {
          result.children.push(info);
        }

        for (const child of el.children) {
          walk(child, depth + 1);
        }
      }

      walk(popper, 0);
      return result;
    })())
  `);

  const dom = JSON.parse(popperDOM);
  if (!dom.found) {
    console.log('No popper content found');
    ws.close(); return;
  }

  console.log(`\n=== Popper DOM (${dom.children.length} elements) ===\n`);
  dom.children.forEach(c => {
    const markers = [];
    if (c.dataState) markers.push(`state=${c.dataState}`);
    if (c.ariaChecked) markers.push(`checked=${c.ariaChecked}`);
    if (c.ariaSelected) markers.push(`selected=${c.ariaSelected}`);
    if (c.role) markers.push(`role=${c.role}`);
    if (c.clickable) markers.push('CLICKABLE');
    console.log(`  ${c.tag} "${c.text}" at (${c.x},${c.y}) ${c.w}x${c.h} [${markers.join(', ')}]`);
  });

  // Also print partial innerHTML for structure understanding
  console.log('\n=== innerHTML preview ===');
  console.log(dom.innerHTML.substring(0, 1500));

  // Close
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  ws.close();
  console.log('\nDone');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
