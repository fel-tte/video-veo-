/**
 * Navigate to project page -> find settings button -> click via CDP -> inspect menu
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
  console.log('Current URL:', url);

  // Navigate to project page if on edit page
  if (url.includes('/edit/')) {
    const projectUrl = url.split('/edit/')[0];
    console.log('Navigating to project page:', projectUrl);
    await sendCDP(ws, 'Page.navigate', { url: projectUrl });
    await sleep(5000);
    url = await evalJS(ws, 'window.location.href');
    console.log('Now at:', url);
  }

  // Bring browser window to front
  try { await sendCDP(ws, 'Page.bringToFront'); } catch(e) {}
  await sleep(1000);

  // Find settings button
  const btnInfo = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_') && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({
            text: t.substring(0,80), x: r.x + r.width/2, y: r.y + r.height/2,
            left: r.left, top: r.top, width: r.width, height: r.height,
            popup: b.getAttribute('aria-haspopup'), state: b.getAttribute('data-state')
          });
        }
      }
      return null;
    })()
  `);

  if (!btnInfo) {
    console.error('Settings button not found!');

    // Dump all visible buttons for debugging
    const allBtns = await evalJS(ws, `
      JSON.stringify(Array.from(document.querySelectorAll('button'))
        .filter(b => b.getBoundingClientRect().width > 0)
        .map(b => (b.textContent?.trim() || '').substring(0,60))
        .filter(t => t.length > 0))
    `);
    console.log('All buttons:', allBtns);
    ws.close(); return;
  }

  const btn = JSON.parse(btnInfo);
  console.log('\nSettings button found:', btn);

  // CDP Click
  console.log('\n--- CDP Click at button center ---');
  const x = Math.round(btn.x);
  const y = Math.round(btn.y);
  await fullCDPClick(ws, x, y);

  // Check multiple times
  for (const wait of [500, 1000, 1500, 2000, 3000]) {
    await sleep(wait === 500 ? 500 : wait - [500,1000,1500,2000].find(w => w < wait));

    const check = await evalJS(ws, `
      JSON.stringify({
        btnState: (function(){
          const btns = document.querySelectorAll('button');
          for (const b of btns) {
            const t = b.textContent?.trim() || '';
            if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_'))
              return { state: b.getAttribute('data-state'), expanded: b.getAttribute('aria-expanded') };
          }
          return null;
        })(),
        menuItems: Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'))
          .filter(e => e.getBoundingClientRect().width > 0)
          .map(e => ({ text: (e.textContent?.trim()||'').substring(0,40), state: e.getAttribute('data-state')||'' })),
        radixPoppers: document.querySelectorAll('[data-radix-popper-content-wrapper]').length,
        openElements: Array.from(document.querySelectorAll('[data-state="open"]')).map(e => e.tagName + '#' + (e.id||'').substring(0,20))
      })
    `);
    console.log(`  After ${wait}ms:`, check);

    const data = JSON.parse(check);
    if (data.menuItems.length > 0) {
      console.log('\n=== MENU ITEMS FOUND ===');
      data.menuItems.forEach(i => console.log(`  [${i.state}] ${i.text}`));
      break;
    }
  }

  // If still no menu, try screenshot
  const finalCheck = await evalJS(ws, `document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]').length`);
  if (finalCheck === 0) {
    console.log('\nMenu still not opened. Taking screenshot...');
    const screenshot = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync('c:/Users/Admin/Desktop/veo3/scripts/debug-screenshot.png', Buffer.from(screenshot.data, 'base64'));
    console.log('Saved: scripts/debug-screenshot.png');

    // Also try: the edit page has a model dropdown ("Veo 3.1 - Fast arrow_drop_down")
    // Maybe settings can only be changed from the edit/detail page
    console.log('\n--- ALTERNATIVE: Test model dropdown on edit page ---');
    // Navigate to latest media
    const openLatest = await evalJS(ws, `
      (function(){
        const items = document.querySelectorAll('[id^="fe_id_"]');
        if (items.length === 0) return 'no items';
        const last = items[items.length - 1];
        const link = last.querySelector('a');
        if (link) { link.click(); return 'clicked: ' + link.href; }
        last.click();
        return 'clicked item directly';
      })()
    `);
    console.log('Open latest:', openLatest);
    await sleep(4000);

    // Find model dropdown on edit page
    const modelBtn = await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t.includes('Veo') || t.includes('Imagen') || t.includes('Nano')) && t.includes('arrow_drop_down') && b.getBoundingClientRect().width > 0) {
            const r = b.getBoundingClientRect();
            return JSON.stringify({ text: t.substring(0,60), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), popup: b.getAttribute('aria-haspopup') });
          }
        }
        return null;
      })()
    `);
    if (modelBtn) {
      const mb = JSON.parse(modelBtn);
      console.log('Model dropdown found:', mb);
      await fullCDPClick(ws, mb.x, mb.y);
      await sleep(2000);

      const modelItems = await evalJS(ws, `
        JSON.stringify(
          Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]'))
            .filter(e => e.getBoundingClientRect().width > 0)
            .map(e => ({
              text: (e.textContent?.trim()||'').substring(0,60),
              state: e.getAttribute('data-state')||'',
              role: e.getAttribute('role'),
              x: Math.round(e.getBoundingClientRect().x + e.getBoundingClientRect().width/2),
              y: Math.round(e.getBoundingClientRect().y + e.getBoundingClientRect().height/2)
            }))
        )
      `);
      const mi = JSON.parse(modelItems);
      console.log(`Model menu items (${mi.length}):`);
      mi.forEach(i => console.log(`  [${i.state}] ${i.role}: "${i.text}" at (${i.x}, ${i.y})`));
    }
  }

  // Close with Escape
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  ws.close();
  console.log('\nDone');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
