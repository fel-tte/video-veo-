/**
 * Debug settings dropdown — find why menu items weren't detected
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
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const pages = await getPages();

  // Navigate back to project page if on edit page
  let flowPage = pages.find(p => p.url.includes('flow/project'));
  if (!flowPage) { console.error('No Flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  let url = await evalJS(ws, 'window.location.href');
  console.log('Current URL:', url);

  // If on edit page, go back
  if (url.includes('/edit/')) {
    const projectUrl = url.split('/edit/')[0];
    console.log('Navigating back to project page...');
    await sendCDP(ws, 'Page.navigate', { url: projectUrl });
    await sleep(4000);
    url = await evalJS(ws, 'window.location.href');
    console.log('Now at:', url);
  }

  // Step 1: Find settings button
  console.log('\n--- Finding settings button ---');
  const settingsPos = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_') && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({
            text: t.substring(0,80),
            x: Math.round(r.x + r.width/2),
            y: Math.round(r.y + r.height/2),
            hasPopup: b.getAttribute('aria-haspopup'),
            dataState: b.getAttribute('data-state')
          });
        }
      }
      return null;
    })()
  `);

  if (!settingsPos) {
    console.error('Settings button not found');
    ws.close(); return;
  }

  const sp = JSON.parse(settingsPos);
  console.log('Settings button:', sp);

  // Step 2: CDP click to open dropdown
  console.log('\n--- CDP clicking settings button ---');
  await cdpClick(ws, sp.x, sp.y);

  // Wait progressively and check
  for (const waitMs of [500, 1000, 1500, 2000]) {
    await sleep(waitMs);
    const elapsed = waitMs;

    // Check data-state
    const state = await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) {
            return b.getAttribute('data-state');
          }
        }
        return 'not found';
      })()
    `);
    console.log(`  After ${elapsed}ms: button data-state = "${state}"`);

    // Check for menu items with various selectors
    const menuCheck = await evalJS(ws, `
      JSON.stringify({
        menuitem: document.querySelectorAll('[role="menuitem"]').length,
        menuitemVisible: Array.from(document.querySelectorAll('[role="menuitem"]')).filter(e => e.getBoundingClientRect().width > 0).length,
        menuitemRadio: document.querySelectorAll('[role="menuitemradio"]').length,
        menuitemRadioVisible: Array.from(document.querySelectorAll('[role="menuitemradio"]')).filter(e => e.getBoundingClientRect().width > 0).length,
        option: document.querySelectorAll('[role="option"]').length,
        listbox: document.querySelectorAll('[role="listbox"]').length,
        menu: document.querySelectorAll('[role="menu"]').length,
        menubar: document.querySelectorAll('[role="menubar"]').length,
        radixContent: document.querySelectorAll('[data-radix-popper-content-wrapper]').length,
        radixMenu: document.querySelectorAll('[data-radix-menu-content]').length,
        allDataState: Array.from(document.querySelectorAll('[data-state="open"]')).map(e => ({
          tag: e.tagName,
          role: e.getAttribute('role'),
          text: e.textContent?.substring(0,50)
        }))
      })
    `);
    const mc = JSON.parse(menuCheck);
    console.log(`  Menu elements:`, mc);

    if (mc.menuitem > 0 || mc.menuitemRadio > 0 || mc.radixContent > 0 || mc.option > 0) {
      console.log('\n--- Menu detected! Getting items ---');

      // Get all menu-like items
      const items = await evalJS(ws, `
        JSON.stringify(
          Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]'))
            .filter(el => el.getBoundingClientRect().width > 0)
            .map(el => ({
              role: el.getAttribute('role'),
              text: el.textContent?.trim()?.substring(0, 80),
              state: el.getAttribute('data-state') || el.getAttribute('aria-checked') || '',
              tag: el.tagName,
              x: Math.round(el.getBoundingClientRect().x + el.getBoundingClientRect().width/2),
              y: Math.round(el.getBoundingClientRect().y + el.getBoundingClientRect().height/2)
            }))
        )
      `);
      const parsed = JSON.parse(items);
      console.log(`Found ${parsed.length} items:`);
      parsed.forEach(i => {
        console.log(`  [${i.state || '-'}] ${i.role}: "${i.text}" at (${i.x}, ${i.y})`);
      });

      // Test clicking Video item
      const videoItem = parsed.find(i => i.text.includes('Video'));
      if (videoItem) {
        console.log(`\n--- Clicking Video at (${videoItem.x}, ${videoItem.y}) ---`);
        await cdpClick(ws, videoItem.x, videoItem.y);
        await sleep(1000);

        // Check button text changed
        const newText = await evalJS(ws, `
          (function(){
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
              const t = b.textContent?.trim() || '';
              if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) return t.substring(0,80);
            }
            return 'not found';
          })()
        `);
        console.log('New button text:', newText);
      }

      break;
    }
  }

  // Close menu with Escape
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);

  console.log('\nDone');
  ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
