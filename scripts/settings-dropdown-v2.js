const WebSocket = require('ws');
const http = require('http');

async function getPages() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function sendCDP(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 100000);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP timeout')), 30000);
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
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return result.value;
}

async function main() {
  const pages = await getPages();
  const flowPage = pages.find(p => p.url.includes('flow') && !p.url.includes('/edit/'));
  if (!flowPage) { console.error('No flow project page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  console.log('URL:', await evalJS(ws, 'window.location.href'));

  // Method 1: Try dispatchEvent with proper mouse events
  console.log('\n=== METHOD 1: Dispatch mousedown+mouseup+click ===');
  const m1 = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button[aria-haspopup="menu"]');
      for (const b of btns) {
        if (b.textContent?.includes('Nano') || b.textContent?.includes('Veo')) {
          b.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
          b.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true}));
          b.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
          return 'dispatched on: ' + b.textContent?.trim()?.substring(0,40);
        }
      }
      return 'not found';
    })()
  `);
  console.log(m1);
  await new Promise(r => setTimeout(r, 3000));

  // Check state
  let state = await evalJS(ws, `
    (function(){
      const b = document.querySelector('button[aria-haspopup="menu"]');
      return b ? JSON.stringify({
        expanded: b.getAttribute('aria-expanded'),
        state: b.getAttribute('data-state'),
        controls: b.getAttribute('aria-controls') || ''
      }) : 'null';
    })()
  `);
  console.log('State after M1:', state);

  // Check DOM
  let dom = await evalJS(ws, `
    (function(){
      const all = [];
      document.querySelectorAll('[role="menu"], [role="menuitem"], [data-radix-menu-content], [data-radix-popper-content-wrapper]').forEach(el => {
        all.push({tag: el.tagName, role: el.getAttribute('role'), visible: el.getBoundingClientRect().width > 0, text: el.textContent?.trim()?.substring(0,200)});
      });
      // Also check portals
      document.querySelectorAll('[data-radix-portal]').forEach(el => {
        all.push({tag: 'PORTAL', visible: el.getBoundingClientRect().width > 0, text: el.textContent?.trim()?.substring(0,200)});
      });
      return JSON.stringify(all);
    })()
  `);
  console.log('Menu elements:', dom);

  // Method 2: Try using Input.dispatchMouseEvent CDP
  console.log('\n=== METHOD 2: CDP Input.dispatchMouseEvent ===');
  const rect = await evalJS(ws, `
    (function(){
      const b = document.querySelector('button[aria-haspopup="menu"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
    })()
  `);
  console.log('Button position:', rect);

  if (rect) {
    const pos = JSON.parse(rect);
    // First close any existing state
    await evalJS(ws, 'document.body.click()');
    await new Promise(r => setTimeout(r, 1000));

    await sendCDP(ws, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1
    });
    await sendCDP(ws, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1
    });
    await new Promise(r => setTimeout(r, 3000));

    state = await evalJS(ws, `
      (function(){
        const b = document.querySelector('button[aria-haspopup="menu"]');
        return b ? JSON.stringify({
          expanded: b.getAttribute('aria-expanded'),
          state: b.getAttribute('data-state'),
          controls: b.getAttribute('aria-controls') || ''
        }) : 'null';
      })()
    `);
    console.log('State after M2:', state);

    dom = await evalJS(ws, `
      (function(){
        const all = [];
        document.querySelectorAll('[role="menu"], [role="menuitem"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [data-radix-portal]').forEach(el => {
          all.push({tag: el.tagName, role: el.getAttribute('role'), visible: el.getBoundingClientRect().width > 0, text: el.textContent?.trim()?.substring(0,200)});
        });
        // High z-index
        document.querySelectorAll('*').forEach(el => {
          const z = parseInt(window.getComputedStyle(el).zIndex);
          if (z > 100 && el.getBoundingClientRect().width > 0 && el.textContent?.trim()?.length > 3) {
            all.push({tag: el.tagName+'_Z'+z, visible: true, text: el.textContent?.trim()?.substring(0,200)});
          }
        });
        return JSON.stringify(all, null, 2);
      })()
    `);
    console.log('Menu elements after M2:', dom);
  }

  // Method 3: Try using Radix trigger
  console.log('\n=== METHOD 3: Radix trigger ID ===');
  const radixInfo = await evalJS(ws, `
    (function(){
      const b = document.querySelector('button[aria-haspopup="menu"]');
      if (!b) return 'null';
      return JSON.stringify({
        id: b.id,
        allAttrs: Array.from(b.attributes).map(a => a.name + '=' + a.value).join(', '),
        parentHTML: b.parentElement?.outerHTML?.substring(0, 800) || ''
      }, null, 2);
    })()
  `);
  console.log(radixInfo);

  // Method 4: Try programmatic Radix state change
  console.log('\n=== METHOD 4: Force data-state=open ===');
  await evalJS(ws, `
    (function(){
      const b = document.querySelector('button[aria-haspopup="menu"]');
      if (b) {
        b.setAttribute('data-state', 'open');
        b.setAttribute('aria-expanded', 'true');
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 2000));

  dom = await evalJS(ws, `
    (function(){
      const all = [];
      document.querySelectorAll('[role="menu"], [data-radix-portal], [data-radix-popper-content-wrapper]').forEach(el => {
        all.push({tag: el.tagName, visible: el.getBoundingClientRect().width > 0, text: el.textContent?.trim()?.substring(0,200)});
      });
      return JSON.stringify(all);
    })()
  `);
  console.log('After force open:', dom);

  // Reset
  await evalJS(ws, `
    (function(){
      const b = document.querySelector('button[aria-haspopup="menu"]');
      if (b) {
        b.setAttribute('data-state', 'closed');
        b.setAttribute('aria-expanded', 'false');
      }
    })()
  `);

  // Method 5: Try using PointerEvent
  console.log('\n=== METHOD 5: PointerEvent ===');
  await evalJS(ws, `
    (function(){
      const b = document.querySelector('button[aria-haspopup="menu"]');
      if (b) {
        b.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse'}));
        b.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse'}));
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 3000));

  state = await evalJS(ws, `
    (function(){
      const b = document.querySelector('button[aria-haspopup="menu"]');
      return b ? b.getAttribute('data-state') + ' / ' + b.getAttribute('aria-expanded') : 'null';
    })()
  `);
  console.log('State after M5:', state);

  dom = await evalJS(ws, `
    (function(){
      const menus = document.querySelectorAll('[role="menu"]');
      return 'Menu count: ' + menus.length + ', visible: ' + Array.from(menus).filter(m => m.getBoundingClientRect().width > 0).length;
    })()
  `);
  console.log(dom);

  ws.close();
  console.log('\nDone.');
}

main().catch(console.error);
