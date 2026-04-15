const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

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

  // First snapshot all DOM element count
  const beforeCount = await evalJS(ws, 'document.querySelectorAll("*").length');
  console.log('DOM elements before click:', beforeCount);

  // Click the model button
  console.log('\nClicking model selector...');
  await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('Veo') && t.includes('arrow_drop_down')) { b.click(); return; }
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 2000));

  const afterCount = await evalJS(ws, 'document.querySelectorAll("*").length');
  console.log('DOM elements after click:', afterCount);
  console.log('New elements:', afterCount - beforeCount);

  // Take screenshot
  const { data: screenshotData } = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('c:/Users/Admin/Desktop/veo3/scripts/model-dropdown.png', Buffer.from(screenshotData, 'base64'));
  console.log('\nScreenshot saved: scripts/model-dropdown.png');

  // Get the ENTIRE page HTML around the model button
  const modelBtnInfo = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('Veo') && t.includes('arrow_drop_down')) {
          // Get parent hierarchy
          let p = b.parentElement;
          for (let i = 0; i < 5; i++) {
            if (!p) break;
            const siblings = Array.from(p.children).map(c => ({
              tag: c.tagName,
              text: c.textContent?.trim()?.substring(0, 100),
              visible: c.getBoundingClientRect().width > 0,
              childCount: c.children.length,
              className: c.className?.substring?.(0, 60) || '',
              ariaExpanded: c.getAttribute('aria-expanded'),
              ariaHaspopup: c.getAttribute('aria-haspopup'),
              dataState: c.getAttribute('data-state')
            }));
            if (siblings.some(s => s.childCount > 2 || s.ariaExpanded || s.dataState)) {
              return JSON.stringify({ depth: i, siblings: siblings }, null, 2);
            }
            p = p.parentElement;
          }
          return JSON.stringify({
            buttonHTML: b.outerHTML?.substring(0, 500),
            parentHTML: b.parentElement?.outerHTML?.substring(0, 1000)
          }, null, 2);
        }
      }
      return 'Button not found';
    })()
  `);
  console.log('\n=== Model Button Context ===');
  console.log(modelBtnInfo);

  // Check for any element that has "3.1" or "Veo" text that appeared
  const veoElements = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('*')).filter(el => {
        const t = el.textContent?.trim() || '';
        const own = el.childNodes.length <= 2;
        return own && el.getBoundingClientRect().width > 0 && (t.includes('Veo') || t.includes('3.1') || t.includes('Nano') || t.includes('Banana') || t.includes('Fast') || t.includes('Standard'));
      }).map(el => ({
        tag: el.tagName,
        text: el.textContent?.trim()?.substring(0, 80),
        className: el.className?.substring?.(0, 60) || '',
        rect: { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), y: Math.round(el.getBoundingClientRect().y) }
      }))
    )
  `);
  console.log('\n=== Elements with Veo/Model text ===');
  console.log(veoElements);

  // Navigate back to project page and inspect the model selector there
  console.log('\n\n=== GOING BACK TO PROJECT PAGE ===');
  await sendCDP(ws, 'Page.navigate', { url: 'https://labs.google/fx/tools/flow/project/ff1af752-3ed8-46f4-86ed-740aecca9681' });
  await new Promise(r => setTimeout(r, 6000));

  // Click the combined model/aspect/count button
  console.log('\nClicking combined settings button...');
  await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('Nano') && t.includes('crop') && t.includes('x2')) { b.click(); return 'Clicked'; }
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 2000));

  // Screenshot
  const { data: ss2 } = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('c:/Users/Admin/Desktop/veo3/scripts/settings-panel.png', Buffer.from(ss2, 'base64'));
  console.log('Screenshot saved: scripts/settings-panel.png');

  // Get ALL visible content
  console.log('\n=== Full page text after click ===');
  console.log(await evalJS(ws, 'document.body?.innerText || ""'));

  // Get new elements
  console.log('\n=== New buttons ===');
  console.log(await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],[role="radio"]'))
        .filter(b => b.getBoundingClientRect().width > 0)
        .map(b => ({
          text: b.textContent?.trim()?.substring(0,100),
          role: b.getAttribute('role') || '',
          checked: b.getAttribute('aria-checked') || b.getAttribute('data-state') || '',
          ariaLabel: b.getAttribute('aria-label') || ''
        }))
    , null, 2)
  `));

  ws.close();
  console.log('\nDone.');
}

main().catch(console.error);
