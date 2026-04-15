/**
 * Use Strategy 4 (synthetic pointer events) and inspect the opened menu DOM
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

// Opens settings dropdown using synthetic pointer events (Strategy 4 - proven to work)
async function openSettingsDropdown(ws) {
  return await evalJS(ws, `
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
          return 'opened';
        }
      }
      return 'not found';
    })()
  `);
}

async function main() {
  const pages = await getPages();
  let flowPage = pages.find(p => p.url.includes('flow/project') && !p.url.includes('/edit/'));
  if (!flowPage) flowPage = pages.find(p => p.url.includes('flow/project'));
  if (!flowPage) { console.error('No Flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);

  // Open the dropdown
  console.log('Opening settings dropdown...');
  const result = await openSettingsDropdown(ws);
  console.log('Result:', result);

  // Wait longer for the menu to render
  for (const delay of [500, 1000, 2000, 3000]) {
    await sleep(delay === 500 ? 500 : delay - (delay === 1000 ? 500 : delay === 2000 ? 1000 : 2000));

    // Deep scan for ALL interactive elements that appeared
    const scan = await evalJS(ws, `
      JSON.stringify((function(){
        const result = {
          menuitem: [],
          menuitemradio: [],
          option: [],
          buttons_in_menu: [],
          radix: [],
          portal: [],
          popover: [],
          divWithRole: [],
          allNewOpen: []
        };

        // menuitem / menuitemradio / option
        document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]').forEach(el => {
          const r = el.getBoundingClientRect();
          result.menuitem.push({
            role: el.getAttribute('role'),
            text: (el.textContent?.trim() || '').substring(0, 60),
            visible: r.width > 0,
            w: Math.round(r.width), h: Math.round(r.height),
            x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)
          });
        });

        // Radix popper content
        document.querySelectorAll('[data-radix-popper-content-wrapper], [data-radix-menu-content]').forEach(el => {
          result.radix.push({
            tag: el.tagName,
            children: el.children.length,
            text: (el.textContent?.trim() || '').substring(0, 200)
          });
        });

        // Portal elements
        document.querySelectorAll('[data-radix-portal], [class*="portal"], [id*="radix"]').forEach(el => {
          result.portal.push({
            tag: el.tagName,
            id: el.id?.substring(0, 40),
            children: el.children.length,
            text: (el.textContent?.trim() || '').substring(0, 200)
          });
        });

        // Any data-state="open" elements
        document.querySelectorAll('[data-state="open"]').forEach(el => {
          const r = el.getBoundingClientRect();
          result.allNewOpen.push({
            tag: el.tagName,
            role: el.getAttribute('role'),
            id: (el.id || '').substring(0, 40),
            class: (el.className || '').substring(0, 80),
            text: (el.textContent?.trim() || '').substring(0, 100),
            visible: r.width > 0,
            w: Math.round(r.width), h: Math.round(r.height)
          });
        });

        return result;
      })())
    `);

    const s = JSON.parse(scan);
    console.log(`\n--- After ${delay}ms ---`);
    console.log(`menuitem/radio/option: ${s.menuitem.length}`);
    if (s.menuitem.length > 0) {
      s.menuitem.forEach(m => console.log(`  [${m.visible ? 'V' : 'H'}] ${m.role}: "${m.text}" (${m.w}x${m.h}) at (${m.x},${m.y})`));
    }
    console.log(`radix content: ${s.radix.length}`);
    s.radix.forEach(r => console.log(`  ${r.tag}: ${r.children} children, text="${r.text.substring(0,100)}"`));
    console.log(`portals: ${s.portal.length}`);
    s.portal.forEach(p => console.log(`  ${p.tag}#${p.id}: ${p.children} children, text="${p.text.substring(0,100)}"`));
    console.log(`data-state=open: ${s.allNewOpen.length}`);
    s.allNewOpen.forEach(o => console.log(`  ${o.tag}[${o.role||''}]#${o.id}: "${o.text.substring(0,60)}" visible=${o.visible} ${o.w}x${o.h}`));

    if (s.menuitem.length > 0 || s.radix.length > 0) break;
  }

  // Close
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  ws.close();
  console.log('\nDone');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
