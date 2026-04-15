/**
 * Debug: Check page state after timeout, look at the Create button position,
 * and also check if prompt was actually submitted
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

async function cdpClick(ws, x, y) {
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(100);
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(50);
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function main() {
  const pages = await getPages();
  let flowPage = pages.find(p => p.url.includes('flow/project'));
  if (!flowPage) { console.error('No Flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  const url = await evalJS(ws, 'window.location.href');
  console.log('URL:', url);

  if (url.includes('/edit/')) {
    await sendCDP(ws, 'Page.navigate', { url: url.split('/edit/')[0] });
    await sleep(5000);
  }

  // Check current state
  console.log('\n=== Current page state ===');

  // Prompt content
  const promptContent = await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      return ce ? ce.textContent?.substring(0, 100) : 'NOT FOUND';
    })()
  `);
  console.log('Prompt content:', promptContent);

  // Media count
  const mediaCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  console.log('Media count:', mediaCount);

  // Take screenshot
  const ss = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync('c:/Users/Admin/Desktop/veo3/scripts/debug-submit.png', Buffer.from(ss.data, 'base64'));
  console.log('Screenshot: scripts/debug-submit.png');

  // Find ALL Create/Submit buttons
  console.log('\n=== All Create/Submit buttons ===');
  const btns = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(b => {
          const t = b.textContent?.trim() || '';
          return (t.includes('Create') || t.includes('Generate') || t.includes('Submit')) && b.getBoundingClientRect().width > 0;
        })
        .map(b => {
          const r = b.getBoundingClientRect();
          return {
            text: (b.textContent?.trim() || '').substring(0, 60),
            x: Math.round(r.x + r.width/2),
            y: Math.round(r.y + r.height/2),
            disabled: b.disabled,
            ariaDisabled: b.getAttribute('aria-disabled'),
            classes: (b.className || '').substring(0, 80)
          };
        })
    )
  `);
  const createBtns = JSON.parse(btns);
  createBtns.forEach(b => {
    console.log(`  "${b.text}" at (${b.x}, ${b.y}) disabled=${b.disabled} aria-disabled=${b.ariaDisabled}`);
  });

  // Also check: is the settings button nearby the create button?
  const settingsBtn = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button[aria-haspopup="menu"]');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('crop_') && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({ text: t.substring(0,60), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
        }
      }
      return null;
    })()
  `);
  console.log('\nSettings button:', settingsBtn);

  // Check if there's a prompt in the contenteditable, then try to click the correct Create button
  console.log('\n=== Testing Create button click ===');
  if (createBtns.length > 0) {
    // Find the one closest to bottom (y > 700)
    const bottomBtns = createBtns.filter(b => b.y > 700);
    const targetBtn = bottomBtns.length > 0 ? bottomBtns[bottomBtns.length - 1] : createBtns[createBtns.length - 1];
    console.log(`Target Create button: "${targetBtn.text}" at (${targetBtn.x}, ${targetBtn.y})`);

    // Type a test prompt first
    await evalJS(ws, `
      (function(){
        const ce = document.querySelector("div[contenteditable='true']");
        if (!ce) return;
        ce.click(); ce.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(ce);
        sel.removeAllRanges(); sel.addRange(range);
        document.execCommand('insertText', false, 'A serene mountain lake at sunrise, misty, cinematic');
      })()
    `);
    await sleep(1000);

    console.log('Typed prompt. Clicking Create...');
    await cdpClick(ws, targetBtn.x, targetBtn.y);
    await sleep(3000);

    // Check if generation started
    const newCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
    console.log(`Media count after click: ${newCount} (was ${mediaCount})`);

    // Also check page URL — did it navigate?
    const newUrl = await evalJS(ws, 'window.location.href');
    console.log('URL after click:', newUrl);

    // Take screenshot
    const ss2 = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync('c:/Users/Admin/Desktop/veo3/scripts/debug-after-create.png', Buffer.from(ss2.data, 'base64'));
    console.log('Screenshot: scripts/debug-after-create.png');

    // Check for loading indicators
    const loading = await evalJS(ws, `
      JSON.stringify({
        anyProgress: document.querySelectorAll('[class*="progress"], [class*="loading"], [class*="generating"]').length,
        feItems: Array.from(document.querySelectorAll('[id^="fe_id_"]')).map(el => {
          const hasVideo = el.querySelector('video') !== null;
          const hasLoading = el.querySelector('[class*="loading"], [class*="progress"], [class*="generating"]') !== null;
          return { id: el.id.substring(0,30), hasVideo, hasLoading };
        })
      })
    `);
    console.log('Loading state:', loading);
  }

  ws.close();
  console.log('\nDone');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
