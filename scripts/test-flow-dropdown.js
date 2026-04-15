// Open Flow settings dropdown using mouse events at real coordinates
const WebSocket = require('ws');
const fs = require('fs');

const CDP_URL = 'http://127.0.0.1:9222';
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

async function getPage() {
  const resp = await fetch(`${CDP_URL}/json`);
  const pages = await resp.json();
  return pages.find(p => p.url.includes('labs.google'));
}

async function connectCDP(page) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 1; const pending = new Map();
    ws.on('open', () => resolve({
      send(m, p = {}) { return new Promise((res, rej) => { const i = id++; pending.set(i, {resolve:res,reject:rej}); ws.send(JSON.stringify({id:i,method:m,params:p})); }); },
      close() { ws.close(); }
    }));
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }});
    ws.on('error', reject);
  });
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
}

async function mouseClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function screenshot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`scripts/${name}.png`, Buffer.from(r.data, 'base64'));
  log(`Screenshot: scripts/${name}.png`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const page = await getPage();
  if (!page) { log('No page found'); return; }
  const cdp = await connectCDP(page);

  try {
    log(`URL: ${await evaluate(cdp, 'window.location.href')}`);

    // Get button coordinates
    const btnInfo = await evaluate(cdp, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.includes('crop_') && b.getBoundingClientRect().y > 500);
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2, text: btn.textContent.trim() });
      })()
    `);
    log(`Button: ${btnInfo}`);
    const { x, y } = JSON.parse(btnInfo);

    // Click using CDP mouse events
    log(`\nClicking at (${Math.round(x)}, ${Math.round(y)})...`);
    await mouseClick(cdp, x, y);
    await sleep(1500);

    await screenshot(cdp, 'flow-mouse-click-1');

    // Check what opened
    const check1 = await evaluate(cdp, `
      (() => {
        const tabs = document.querySelectorAll('[role="tab"]');
        const menus = document.querySelectorAll('[role="menuitem"]');
        const options = document.querySelectorAll('[role="option"]');
        const radix = document.querySelectorAll('[data-radix-popper-content-wrapper]');
        const portals = document.querySelectorAll('[data-radix-portal]');
        return JSON.stringify({
          tabs: Array.from(tabs).map(t => ({ text: t.textContent.trim(), state: t.getAttribute('data-state') })),
          menus: Array.from(menus).map(m => ({ text: m.textContent.trim() })),
          options: Array.from(options).map(o => ({ text: o.textContent.trim() })),
          radixPoppers: radix.length,
          radixPortals: Array.from(portals).map(p => ({
            html: p.innerHTML.substring(0, 500),
            text: p.textContent.trim().substring(0, 200)
          })),
          expandedBtn: document.querySelector('[aria-expanded="true"]')?.textContent?.trim()
        });
      })()
    `);
    log(`After click: ${check1}`);

    // If no dropdown, try double click or right click
    const parsed = JSON.parse(check1);
    if (parsed.tabs.length === 0 && parsed.radixPoppers === 0 && parsed.radixPortals.length === 0) {
      log('\nNo dropdown detected. Trying again with hover first...');

      // Move mouse to button, hover, then click
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(500);
      await mouseClick(cdp, x, y);
      await sleep(2000);

      await screenshot(cdp, 'flow-mouse-click-2');

      const check2 = await evaluate(cdp, `
        (() => {
          const portals = document.querySelectorAll('[data-radix-portal]');
          const expanded = document.querySelector('[aria-expanded="true"]');
          // Also check for any new visible overlays
          const overlays = document.querySelectorAll('[data-state="open"]');
          return JSON.stringify({
            portals: portals.length,
            portalTexts: Array.from(portals).map(p => p.textContent.trim().substring(0, 300)),
            expanded: expanded?.textContent?.trim(),
            overlays: Array.from(overlays).map(o => ({
              tag: o.tagName, text: o.textContent.trim().substring(0, 200),
              role: o.getAttribute('role')
            }))
          });
        })()
      `);
      log(`After hover+click: ${check2}`);
    }

    // Try to see if the "Video" text itself is a separate clickable element
    log('\n=== Looking for inner clickable elements ===');
    const innerEls = await evaluate(cdp, `
      (() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.includes('crop_') && b.getBoundingClientRect().y > 500);
        if (!btn) return 'no btn';

        // Get ALL descendants
        const desc = btn.querySelectorAll('*');
        return JSON.stringify(Array.from(desc).map(d => ({
          tag: d.tagName,
          text: d.textContent.trim().substring(0, 30),
          class: d.className?.substring?.(0, 50) || '',
          rect: d.getBoundingClientRect().toJSON()
        })));
      })()
    `);
    log(`Inner elements: ${innerEls}`);

    // Try clicking just on the "Video" text part (leftmost part of button)
    log('\n=== Click on "Video" text area ===');
    const videoX = JSON.parse(btnInfo).x - 30; // more to the left for "Video" text
    await mouseClick(cdp, videoX, y);
    await sleep(2000);
    await screenshot(cdp, 'flow-video-area-click');

    const check3 = await evaluate(cdp, `
      (() => {
        const portals = document.querySelectorAll('[data-radix-portal]');
        const tabs = document.querySelectorAll('[role="tab"]');
        return JSON.stringify({
          portals: Array.from(portals).map(p => p.textContent.trim().substring(0, 300)),
          tabs: Array.from(tabs).map(t => ({ text: t.textContent.trim(), state: t.getAttribute('data-state') }))
        });
      })()
    `);
    log(`After Video area click: ${check3}`);

    // Last resort: check ALL Radix elements on the page
    log('\n=== All Radix triggers on page ===');
    const radixTriggers = await evaluate(cdp, `
      (() => {
        const triggers = document.querySelectorAll('[data-radix-collection-item], [id^="radix-"]');
        return JSON.stringify(Array.from(triggers).map(t => ({
          id: t.id,
          tag: t.tagName,
          text: t.textContent.trim().substring(0, 60),
          state: t.getAttribute('data-state'),
          role: t.getAttribute('role'),
          haspopup: t.getAttribute('aria-haspopup'),
          expanded: t.getAttribute('aria-expanded'),
          y: Math.round(t.getBoundingClientRect().y)
        })).filter(t => t.y > 0));
      })()
    `);
    log(`Radix triggers: ${radixTriggers}`);

  } finally {
    cdp.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
