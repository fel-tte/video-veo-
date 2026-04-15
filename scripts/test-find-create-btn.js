/**
 * Find the exact Create button position — it's next to the settings button
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
  let flowPage = pages.find(p => p.url.includes('flow/project') && !p.url.includes('/edit/'));
  if (!flowPage) flowPage = pages.find(p => p.url.includes('flow/project'));
  if (!flowPage) { console.error('No Flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  const url = await evalJS(ws, 'window.location.href');
  console.log('URL:', url);

  if (url.includes('/edit/')) {
    await sendCDP(ws, 'Page.navigate', { url: url.split('/edit/')[0] });
    await sleep(5000);
  }

  // Get ALL buttons in the bottom area (y > 700)
  const allBtns = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('button'))
        .filter(b => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().y > 680)
        .map(b => {
          const r = b.getBoundingClientRect();
          return {
            text: (b.textContent?.trim() || '').substring(0, 60),
            left: Math.round(r.left),
            top: Math.round(r.top),
            right: Math.round(r.right),
            bottom: Math.round(r.bottom),
            cx: Math.round(r.x + r.width/2),
            cy: Math.round(r.y + r.height/2),
            width: Math.round(r.width),
            height: Math.round(r.height),
            popup: b.getAttribute('aria-haspopup'),
            disabled: b.disabled,
            isCreate: (b.textContent?.trim() || '').includes('Create') && (b.textContent?.trim() || '').includes('arrow_forward')
          };
        })
        .sort((a, b) => a.left - b.left)
    )
  `);

  const buttons = JSON.parse(allBtns);
  console.log(`\nBottom-area buttons (${buttons.length}):`);
  buttons.forEach(b => {
    const tags = [];
    if (b.isCreate) tags.push('CREATE');
    if (b.popup) tags.push(`popup=${b.popup}`);
    if (b.disabled) tags.push('DISABLED');
    console.log(`  [${b.left}-${b.right}, ${b.top}-${b.bottom}] center=(${b.cx},${b.cy}) "${b.text}" ${tags.join(' ')}`);
  });

  // Also check the contenteditable and any submit elements near it
  const promptArea = await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return null;
      const r = ce.getBoundingClientRect();
      return JSON.stringify({
        text: ce.textContent?.substring(0, 80),
        left: Math.round(r.left), top: Math.round(r.top),
        right: Math.round(r.right), bottom: Math.round(r.bottom)
      });
    })()
  `);
  console.log('\nPrompt area:', promptArea);

  // Find the Create button with a circle/arrow icon
  const createBtn = buttons.find(b => b.isCreate);
  if (createBtn) {
    console.log(`\n=== CREATE button found ===`);
    console.log(`  Position: (${createBtn.cx}, ${createBtn.cy})`);
    console.log(`  Bounds: [${createBtn.left}-${createBtn.right}, ${createBtn.top}-${createBtn.bottom}]`);
    console.log(`  Text: "${createBtn.text}"`);

    // Type prompt and click
    console.log('\nTyping prompt...');
    await evalJS(ws, `
      (function(){
        const ce = document.querySelector("div[contenteditable='true']");
        if (!ce) return;
        ce.click(); ce.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(ce);
        sel.removeAllRanges(); sel.addRange(range);
        document.execCommand('insertText', false, 'Cute kitten sleeping on a cloud, dreamy pastel colors, 4K');
      })()
    `);
    await sleep(1000);

    // Re-check Create button position (it may move after typing)
    const newCreateBtn = await evalJS(ws, `
      (function(){
        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
          const t = b.textContent?.trim() || '';
          if (t.includes('Create') && t.includes('arrow_forward') && b.getBoundingClientRect().width > 0) {
            const r = b.getBoundingClientRect();
            if (r.y > 680) {
              return JSON.stringify({ cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2), text: t.substring(0,40), disabled: b.disabled });
            }
          }
        }
        return null;
      })()
    `);
    console.log('Create button after typing:', newCreateBtn);

    if (newCreateBtn) {
      const btn = JSON.parse(newCreateBtn);
      console.log(`Clicking Create at (${btn.cx}, ${btn.cy})...`);
      await cdpClick(ws, btn.cx, btn.cy);
      await sleep(5000);

      // Check media count
      const count = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
      console.log(`Media count after submit: ${count}`);

      // Check page for generating indicators
      const pageText = await evalJS(ws, `
        (function(){
          // Check for any "generating" text on page
          const body = document.body.innerText;
          const generatingIdx = body.indexOf('enerating');
          if (generatingIdx > -1) return 'Found "generating": ...' + body.substring(Math.max(0,generatingIdx-20), generatingIdx+30) + '...';
          return 'No "generating" text found';
        })()
      `);
      console.log('Page text:', pageText);
    }
  } else {
    console.log('\nNo Create button found!');

    // Maybe it's a different format — look for any submit-like element
    const allSubmitLike = await evalJS(ws, `
      JSON.stringify(
        Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter(b => b.getBoundingClientRect().width > 0)
          .filter(b => {
            const t = b.textContent?.trim()?.toLowerCase() || '';
            return t.includes('create') || t.includes('generate') || t.includes('submit') || t.includes('send') || t.includes('arrow_forward');
          })
          .map(b => {
            const r = b.getBoundingClientRect();
            return { text: (b.textContent?.trim()||'').substring(0,60), cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2) };
          })
      )
    `);
    console.log('Submit-like elements:', allSubmitLike);
  }

  ws.close();
  console.log('\nDone');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
