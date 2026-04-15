/**
 * Quick check: what's on the page now?
 */
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
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
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

async function evalJS(ws, expression) {
  const { result } = await sendCDP(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  });
  if (result.subtype === 'error') throw new Error(result.description);
  return result.value;
}

async function main() {
  const pages = await getPages();
  console.log('=== Open pages ===');
  pages.forEach(p => console.log(`  ${p.url}`));

  for (const page of pages) {
    if (!page.url.includes('labs.google')) continue;

    const ws = await new Promise((resolve, reject) => {
      const w = new WebSocket(page.webSocketDebuggerUrl);
      w.on('open', () => resolve(w));
      w.on('error', reject);
    });

    const url = await evalJS(ws, 'window.location.href');
    console.log(`\n=== Page: ${url} ===`);

    // All buttons
    const btns = await evalJS(ws, `
      JSON.stringify(
        Array.from(document.querySelectorAll('button'))
          .filter(b => b.getBoundingClientRect().width > 0)
          .map(b => {
            const r = b.getBoundingClientRect();
            return {
              text: (b.textContent?.trim() || '').substring(0, 60),
              x: Math.round(r.x + r.width/2),
              y: Math.round(r.y + r.height/2),
              popup: b.getAttribute('aria-haspopup'),
              state: b.getAttribute('data-state')
            };
          })
          .filter(b => b.text.length > 0)
      )
    `);
    const buttons = JSON.parse(btns);
    console.log(`Visible buttons (${buttons.length}):`);
    buttons.forEach(b => {
      const mark = (b.text.includes('Nano') || b.text.includes('Veo')) && b.text.includes('crop_') ? ' <<<< SETTINGS' : '';
      console.log(`  [${b.state || '-'}] "${b.text}" at (${b.x},${b.y}) popup=${b.popup}${mark}`);
    });

    // Check for contenteditable
    const hasPrompt = await evalJS(ws, `!!document.querySelector("div[contenteditable='true']")`);
    console.log(`Has prompt input: ${hasPrompt}`);

    // Check for media items
    const mediaCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
    console.log(`Media items: ${mediaCount}`);

    ws.close();
  }
}

main().catch(e => console.error('FATAL:', e.message));
