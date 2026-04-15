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

  // Close any open menus first
  await evalJS(ws, 'document.body.click()');
  await new Promise(r => setTimeout(r, 1000));

  // Get exact position of the settings button (the one with Nano/Veo + crop)
  console.log('\n=== SETTINGS BUTTON POSITION ===');
  const btnInfo = await evalJS(ws, `
    JSON.stringify((function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_') && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          return {
            text: t.substring(0, 60),
            id: b.id,
            x: Math.round(r.x + r.width/2),
            y: Math.round(r.y + r.height/2),
            w: Math.round(r.width),
            h: Math.round(r.height),
            ariaHaspopup: b.getAttribute('aria-haspopup') || '',
            dataState: b.getAttribute('data-state') || ''
          };
        }
      }
      return null;
    })())
  `);
  console.log(btnInfo);

  if (!btnInfo) {
    console.error('Settings button not found');
    ws.close();
    return;
  }

  const btn = JSON.parse(btnInfo);
  console.log(`Clicking at (${btn.x}, ${btn.y})`);

  // Use CDP mouse events at the exact position
  await sendCDP(ws, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1
  });
  await sendCDP(ws, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1
  });

  console.log('CDP click dispatched, waiting...');
  await new Promise(r => setTimeout(r, 3000));

  // Check button state
  const stateAfter = await evalJS(ws, `
    JSON.stringify((function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_')) {
          return {
            state: b.getAttribute('data-state'),
            expanded: b.getAttribute('aria-expanded'),
            controls: b.getAttribute('aria-controls') || ''
          };
        }
      }
      return null;
    })())
  `);
  console.log('State after click:', stateAfter);

  // Check for ALL new visible elements
  const newElements = await evalJS(ws, `
    JSON.stringify((function(){
      const results = [];

      // Radix portals/poppers
      document.querySelectorAll('[data-radix-portal], [data-radix-popper-content-wrapper]').forEach(el => {
        if (el.getBoundingClientRect().width > 0) {
          results.push({type: 'radix', text: el.textContent?.trim()?.substring(0,400), html: el.innerHTML?.substring(0,600)});
        }
      });

      // role=menu elements
      document.querySelectorAll('[role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [role="radiogroup"], [role="radio"]').forEach(el => {
        if (el.getBoundingClientRect().width > 0) {
          results.push({type: el.getAttribute('role'), text: el.textContent?.trim()?.substring(0,200), tag: el.tagName});
        }
      });

      // data-state=open
      document.querySelectorAll('[data-state="open"]').forEach(el => {
        if (el.getBoundingClientRect().width > 0 && el.textContent?.trim()?.length > 2) {
          results.push({type: 'open-state', text: el.textContent?.trim()?.substring(0,200), tag: el.tagName, role: el.getAttribute('role') || ''});
        }
      });

      // aria-expanded=true
      document.querySelectorAll('[aria-expanded="true"]').forEach(el => {
        if (el.getBoundingClientRect().width > 0) {
          const ctrl = el.getAttribute('aria-controls');
          const target = ctrl ? document.getElementById(ctrl) : null;
          results.push({
            type: 'expanded',
            id: el.id,
            text: el.textContent?.trim()?.substring(0,60),
            controlsId: ctrl || '',
            targetText: target?.textContent?.trim()?.substring(0,300) || '',
            targetVisible: target ? target.getBoundingClientRect().width > 0 : false
          });
        }
      });

      return results;
    })(), null, 2)
  `);
  console.log('\nNew elements after click:');
  console.log(newElements);

  // If menu opened, look for model options
  const parsed = JSON.parse(newElements || '[]');
  if (parsed.length > 0) {
    console.log('\n=== MENU ITEMS ===');
    const items = await evalJS(ws, `
      JSON.stringify(
        Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="radio"], [data-radix-collection-item]'))
          .filter(el => el.getBoundingClientRect().width > 0)
          .map(el => ({
            text: el.textContent?.trim()?.substring(0, 100),
            checked: el.getAttribute('data-state') || el.getAttribute('aria-checked') || '',
            value: el.getAttribute('data-value') || el.getAttribute('value') || ''
          }))
      )
    `);
    console.log(items);
  }

  // Close
  await evalJS(ws, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`);

  ws.close();
  console.log('\nDone.');
}

main().catch(console.error);
