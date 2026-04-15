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
  const { result } = await sendCDP(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.value;
}

async function main() {
  const pages = await getPages();
  const page = pages.find(p => p.url.includes('flow'));
  if (!page) { console.log('No flow page'); return; }

  const ws = await connectToPage(page.webSocketDebuggerUrl);
  console.log('On:', page.url);

  // Click "Veo 3.1 - Fast" dropdown in detail view
  console.log('\n=== Clicking model dropdown ===');
  const click = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('Veo') && t.includes('arrow_drop_down') && b.getBoundingClientRect().width > 0) {
          b.click();
          return 'Clicked: ' + t;
        }
      }
      // Try the model selector button on project page
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && b.getBoundingClientRect().width > 0) {
          b.click();
          return 'Clicked: ' + t;
        }
      }
      return 'Not found';
    })()
  `);
  console.log(click);
  await new Promise(r => setTimeout(r, 2000));

  // Capture everything visible - try multiple approaches
  console.log('\n=== Dropdown content ===');
  const dropdown = await evalJS(ws, `
    JSON.stringify((function(){
      const results = { radixPoppers: [], openStates: [], menus: [], newElements: [] };

      // Method 1: Radix popper
      document.querySelectorAll('[data-radix-popper-content-wrapper]').forEach(el => {
        if (el.getBoundingClientRect().width > 0) {
          results.radixPoppers.push(el.textContent?.trim()?.substring(0, 600));
        }
      });

      // Method 2: data-state="open" elements
      document.querySelectorAll('[data-state="open"]').forEach(el => {
        if (el.getBoundingClientRect().width > 0 && el.textContent?.trim()) {
          results.openStates.push({
            tag: el.tagName,
            role: el.getAttribute('role') || '',
            text: el.textContent?.trim()?.substring(0, 400)
          });
        }
      });

      // Method 3: role=menu/listbox/dialog
      document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [role="radiogroup"]').forEach(el => {
        if (el.getBoundingClientRect().width > 0) {
          results.menus.push({
            role: el.getAttribute('role'),
            text: el.textContent?.trim()?.substring(0, 400)
          });
        }
      });

      // Method 4: Any element with z-index > 10 (overlay)
      document.querySelectorAll('*').forEach(el => {
        const z = parseInt(window.getComputedStyle(el).zIndex);
        if (z > 10 && el.getBoundingClientRect().width > 0 && el.textContent?.trim()?.length > 3 &&
            el.textContent?.trim()?.length < 500) {
          results.newElements.push({
            tag: el.tagName,
            zIndex: z,
            text: el.textContent?.trim()?.substring(0, 300),
            className: el.className?.substring?.(0, 60) || ''
          });
        }
      });

      return results;
    })(), null, 2)
  `);
  console.log(dropdown);

  // Try capturing the entire screen HTML for dropdown
  const overlayHTML = await evalJS(ws, `
    (function(){
      // Check for portal/overlay containers
      const portals = document.querySelectorAll('[data-radix-portal], [class*="portal"], [class*="overlay"], [class*="popover"]');
      const texts = [];
      portals.forEach(p => {
        if (p.getBoundingClientRect().width > 0) {
          texts.push('PORTAL: ' + p.innerHTML?.substring(0, 500));
        }
      });

      // Also check last children of body (usually portals are appended there)
      const body = document.body;
      for (let i = body.children.length - 1; i >= Math.max(0, body.children.length - 5); i--) {
        const child = body.children[i];
        if (child.getBoundingClientRect().width > 0 && child.id !== '__next') {
          texts.push('BODY_CHILD[' + i + ']: tag=' + child.tagName + ' text=' + child.textContent?.trim()?.substring(0, 300));
        }
      }

      return texts.join('\\n\\n');
    })()
  `);
  console.log('\n=== Portals/Overlays ===');
  console.log(overlayHTML);

  ws.close();
  console.log('\nDone.');
}

main().catch(console.error);
