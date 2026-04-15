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
  const flowPage = pages.find(p => p.url.includes('flow'));
  if (!flowPage) { console.error('No flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);

  // First navigate back to project page if on edit page
  const url = await evalJS(ws, 'window.location.href');
  if (url.includes('/edit/')) {
    const projectUrl = url.split('/edit/')[0];
    console.log('On edit page, navigating back to project:', projectUrl);
    await sendCDP(ws, 'Page.navigate', { url: projectUrl });
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log('URL:', await evalJS(ws, 'window.location.href'));

  // Analyze the settings button structure
  console.log('\n=== SETTINGS BUTTON ANALYSIS ===');
  const btnAnalysis = await evalJS(ws, `
    JSON.stringify((function(){
      const btns = document.querySelectorAll('button');
      const results = [];
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo') || t.includes('crop_') || t.match(/^x[0-9]/)) && b.getBoundingClientRect().width > 0) {
          results.push({
            text: t.substring(0, 100),
            outerHTML: b.outerHTML.substring(0, 500),
            ariaHasPopup: b.getAttribute('aria-haspopup') || '',
            ariaExpanded: b.getAttribute('aria-expanded') || '',
            dataState: b.getAttribute('data-state') || '',
            childCount: b.children.length,
            childTags: Array.from(b.children).map(c => c.tagName + '.' + (c.className?.substring?.(0,30) || '')).join(', '),
            parentTag: b.parentElement?.tagName || '',
            parentChildren: b.parentElement?.children?.length || 0,
            siblingButtons: Array.from(b.parentElement?.querySelectorAll('button') || []).filter(sb => sb !== b && sb.getBoundingClientRect().width > 0).map(sb => sb.textContent?.trim()?.substring(0,40)).join(' | ')
          });
        }
      }
      return results;
    })(), null, 2)
  `);
  console.log(btnAnalysis);

  // Click the settings button and check what opens
  console.log('\n=== CLICKING SETTINGS BUTTON ===');
  await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_') && b.getBoundingClientRect().width > 0) {
          b.click();
          return 'clicked';
        }
      }
      return 'not found';
    })()
  `);
  await new Promise(r => setTimeout(r, 2000));

  // Check entire DOM for new elements
  console.log('\n=== DOM CHANGES AFTER CLICK ===');
  const changes = await evalJS(ws, `
    JSON.stringify((function(){
      const results = { portals: [], overlays: [], newPopups: [], bodyLastChildren: [] };

      // Check portals
      document.querySelectorAll('[data-radix-portal], [class*="portal"], [class*="Portal"]').forEach(el => {
        results.portals.push({text: el.textContent?.trim()?.substring(0,300), visible: el.getBoundingClientRect().width > 0});
      });

      // Check overlays/popovers
      document.querySelectorAll('[data-radix-popper-content-wrapper], [class*="popover"], [class*="Popover"], [class*="dropdown"], [class*="Dropdown"]').forEach(el => {
        results.overlays.push({text: el.textContent?.trim()?.substring(0,300), visible: el.getBoundingClientRect().width > 0, html: el.innerHTML?.substring(0,500)});
      });

      // Check high z-index elements
      document.querySelectorAll('*').forEach(el => {
        const style = window.getComputedStyle(el);
        const z = parseInt(style.zIndex);
        if (z > 50 && el.getBoundingClientRect().width > 0 && el.textContent?.trim()?.length > 3) {
          results.newPopups.push({
            tag: el.tagName,
            z: z,
            text: el.textContent?.trim()?.substring(0,200),
            role: el.getAttribute('role') || '',
            dataState: el.getAttribute('data-state') || ''
          });
        }
      });

      // Last 5 body children
      const body = document.body;
      for (let i = body.children.length - 1; i >= Math.max(0, body.children.length - 5); i--) {
        const c = body.children[i];
        if (c.getBoundingClientRect().width > 0) {
          results.bodyLastChildren.push({
            tag: c.tagName,
            id: c.id?.substring(0,30) || '',
            text: c.textContent?.trim()?.substring(0,200),
            childCount: c.children.length
          });
        }
      }

      // Also check aria-expanded=true buttons
      document.querySelectorAll('[aria-expanded="true"]').forEach(el => {
        const related = el.getAttribute('aria-controls');
        if (related) {
          const target = document.getElementById(related);
          if (target) {
            results.newPopups.push({
              tag: 'ARIA_TARGET',
              text: target.textContent?.trim()?.substring(0,300),
              id: related,
              visible: target.getBoundingClientRect().width > 0
            });
          }
        }
      });

      return results;
    })(), null, 2)
  `);
  console.log(changes);

  // Check data-state attributes
  console.log('\n=== DATA-STATE OPEN ELEMENTS ===');
  const openStates = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('[data-state="open"]'))
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => ({
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          text: el.textContent?.trim()?.substring(0, 300),
          children: el.children.length,
          innerHTML: el.innerHTML?.substring(0, 500)
        }))
    )
  `);
  console.log(openStates);

  // Close
  await evalJS(ws, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  ws.close();
  console.log('\nDone.');
}

main().catch(console.error);
