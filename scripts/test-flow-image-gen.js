// Switch to Image mode in Flow, generate, capture API
const WebSocket = require('ws');
const fs = require('fs');

const CDP_URL = 'http://127.0.0.1:9222';
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

async function getPage() {
  const resp = await fetch(`${CDP_URL}/json`);
  const pages = await resp.json();
  return pages.find(p => p.url.includes('labs.google'));
}

async function connectCDP(page) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 1; const pending = new Map(); let eh = null;
    ws.on('open', () => resolve({
      send(m, p={}) { return new Promise((res,rej) => { const i=id++; pending.set(i,{resolve:res,reject:rej}); ws.send(JSON.stringify({id:i,method:m,params:p})); }); },
      onEvent(h) { eh = h; },
      close() { ws.close(); }
    }));
    ws.on('message', d => { const m=JSON.parse(d.toString()); if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);} else if(m.method&&eh) eh(m.method,m.params); });
    ws.on('error', reject);
  });
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
}

async function mouseClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function screenshot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`scripts/${name}.png`, Buffer.from(r.data, 'base64'));
  log(`Screenshot: scripts/${name}.png`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const page = await getPage();
  if (!page) { log('No page found'); return; }
  const cdp = await connectCDP(page);

  try {
    log(`URL: ${await evaluate(cdp, 'window.location.href')}`);

    // Setup fetch interceptor
    await evaluate(cdp, `
      window.__apiCalls = [];
      const _f4 = window.__origFetch4 || window.fetch;
      window.__origFetch4 = _f4;
      window.fetch = async function(...a) {
        const url = typeof a[0]==='string'?a[0]:a[0]?.url||'';
        const m = a[1]?.method||'GET';
        const b = a[1]?.body;
        const r = await _f4.apply(this,a);
        if ((url.includes('googleapis')||url.includes('trpc')) && !url.includes('font') && !url.includes('recaptcha/api')) {
          const c = r.clone();
          const t = await c.text();
          window.__apiCalls.push({url,method:m,req:typeof b==='string'?b:null,status:r.status,resp:t});
        }
        return r;
      };
      'ok'
    `);

    // Enable network
    await cdp.send('Network.enable');
    const netCaptures = [];
    cdp.onEvent((method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const url = params.request.url;
        if (url.includes('googleapis.com') && !url.includes('font') && !url.includes('recaptcha/api')) {
          netCaptures.push({ url, method: params.request.method, postData: params.request.postData });
        }
      }
    });

    // Step 1: Open settings dropdown
    log('\n=== Step 1: Open dropdown ===');
    const btnInfo = await evaluate(cdp, `
      (() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.includes('crop_') && b.getBoundingClientRect().y > 500);
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `);
    const { x, y } = JSON.parse(btnInfo);
    await mouseClick(cdp, x, y);
    await sleep(1500);

    // Verify dropdown opened
    const tabs = await evaluate(cdp, `
      JSON.stringify(Array.from(document.querySelectorAll('[role="tab"]')).map(t => ({
        text: t.textContent.trim(),
        state: t.getAttribute('data-state'),
        rect: t.getBoundingClientRect().toJSON()
      })))
    `);
    log(`Tabs: ${tabs}`);

    // Step 2: Click "Image" tab
    log('\n=== Step 2: Click Image tab ===');
    const tabsParsed = JSON.parse(tabs);
    const imageTab = tabsParsed.find(t => t.text.includes('Image'));
    if (!imageTab) { log('ERROR: No Image tab!'); return; }

    const imgX = imageTab.rect.x + imageTab.rect.width / 2;
    const imgY = imageTab.rect.y + imageTab.rect.height / 2;
    log(`Clicking Image tab at (${Math.round(imgX)}, ${Math.round(imgY)})`);
    await mouseClick(cdp, imgX, imgY);
    await sleep(1000);

    await screenshot(cdp, 'flow-image-mode');

    // Check state changed
    const tabsAfter = await evaluate(cdp, `
      JSON.stringify(Array.from(document.querySelectorAll('[role="tab"]')).map(t => ({
        text: t.textContent.trim(), state: t.getAttribute('data-state')
      })))
    `);
    log(`Tabs after Image click: ${tabsAfter}`);

    // Close dropdown by clicking elsewhere
    await mouseClick(cdp, 400, 300);
    await sleep(500);

    // Check settings button text changed
    const btnText = await evaluate(cdp, `
      (() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => (b.textContent.includes('crop_') || b.textContent.includes('Image') || b.textContent.includes('Video')) && b.getBoundingClientRect().y > 500);
        return btn?.textContent?.trim() || 'not found';
      })()
    `);
    log(`Settings button now: ${btnText}`);

    await screenshot(cdp, 'flow-image-mode-ready');

    // Step 3: Enter prompt and generate
    log('\n=== Step 3: Enter prompt and generate ===');
    netCaptures.length = 0;
    await evaluate(cdp, `window.__apiCalls = []`);

    // Focus prompt
    await evaluate(cdp, `
      (() => {
        const el = document.querySelector('[contenteditable="true"], [data-slate-editor]');
        if (el) { el.focus(); el.click(); }
        return el?.tagName || 'none';
      })()
    `);
    await sleep(300);

    // Select all + delete
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
    await sleep(100);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
    await sleep(200);

    // Type prompt
    await cdp.send('Input.insertText', { text: 'a beautiful sunset over mountain lake, golden hour photography' });
    await sleep(500);
    log('Prompt entered');

    // Click Create button
    const createBtn = await evaluate(cdp, `
      (() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.includes('Create') && b.getBoundingClientRect().y > 500);
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2, text: btn.textContent.trim() });
      })()
    `);
    log(`Create button: ${createBtn}`);
    const createCoords = JSON.parse(createBtn);
    await mouseClick(cdp, createCoords.x, createCoords.y);
    log('Clicked Create!');

    // Wait for API response
    log('Waiting 20s for generation...');
    await sleep(20000);

    await screenshot(cdp, 'flow-image-generated');

    // Collect API calls
    const apiCalls = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__apiCalls || [])`));

    log(`\n========================================`);
    log(`Captured ${apiCalls.length} API calls`);
    log(`========================================`);
    for (const call of apiCalls) {
      log(`\n--- ${call.method} ${call.url} ---`);
      log(`Status: ${call.status}`);
      if (call.req) {
        try {
          const parsed = JSON.parse(call.req);
          log(`Request:\n${JSON.stringify(parsed, null, 2).substring(0, 2000)}`);
        } catch(e) { log(`Request: ${call.req.substring(0, 1000)}`); }
      }
      if (call.resp) {
        try {
          const parsed = JSON.parse(call.resp);
          log(`Response:\n${JSON.stringify(parsed, null, 2).substring(0, 1500)}`);
        } catch(e) { log(`Response: ${call.resp.substring(0, 500)}`); }
      }
    }

    log(`\nNetwork: ${netCaptures.length}`);
    for (const req of netCaptures) {
      log(`${req.method} ${req.url.substring(0, 150)}`);
      if (req.postData) log(`  ${req.postData.substring(0, 500)}`);
    }

    // Save
    fs.writeFileSync('scripts/flow-image-gen-capture.json', JSON.stringify({ apiCalls, network: netCaptures }, null, 2));
    log('\nSaved to scripts/flow-image-gen-capture.json');

  } finally {
    cdp.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
