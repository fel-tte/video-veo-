// Test image generation on Flow - navigate to project first, switch to Image, generate
const WebSocket = require('ws');

const CDP_URL = 'http://127.0.0.1:9222';
const PROJECT_URL = 'https://labs.google/fx/tools/flow/project/4c186f91-4074-42e9-93a8-ed19c00a0da6';

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

async function getPage() {
  const resp = await fetch(`${CDP_URL}/json`);
  const pages = await resp.json();
  return pages.find(p => p.url.includes('labs.google'));
}

async function connectCDP(page) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 1;
    const pending = new Map();
    let eventHandler = null;
    ws.on('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const msgId = id++;
            pending.set(msgId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        onEvent(h) { eventHandler = h; },
        close() { ws.close(); }
      });
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method && eventHandler) {
        eventHandler(msg.method, msg.params);
      }
    });
    ws.on('error', reject);
  });
}

async function evaluate(cdp, expr) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'eval error');
  return result.result.value;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const page = await getPage();
  if (!page) { log('No page found'); return; }
  const cdp = await connectCDP(page);

  try {
    // Navigate to project
    log('Navigating to project...');
    await cdp.send('Page.navigate', { url: PROJECT_URL });
    await sleep(5000);
    log(`URL: ${await evaluate(cdp, 'window.location.href')}`);

    // Enable network
    await cdp.send('Network.enable');
    const netCaptures = [];
    cdp.onEvent((method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const url = params.request.url;
        if ((url.includes('googleapis.com') || url.includes('trpc')) && !url.includes('font') && !url.includes('recaptcha/api')) {
          netCaptures.push({ url, method: params.request.method, postData: params.request.postData });
          log(`  >> ${params.request.method} ${url.substring(0, 120)}`);
          if (params.request.postData) log(`     ${params.request.postData.substring(0, 200)}`);
        }
      }
    });

    // Override fetch
    await evaluate(cdp, `
      window.__apiCalls = [];
      const _f = window.__of2 || window.fetch;
      window.__of2 = _f;
      window.fetch = async function(...a) {
        const url = typeof a[0]==='string'?a[0]:a[0]?.url||'';
        const m = a[1]?.method||'GET';
        const b = a[1]?.body;
        const r = await _f.apply(this,a);
        if ((url.includes('googleapis')||url.includes('trpc')) && !url.includes('font') && !url.includes('recaptcha/api')) {
          const c = r.clone();
          const t = await c.text();
          window.__apiCalls.push({url,method:m,req:typeof b==='string'?b.substring(0,2000):null,status:r.status,resp:t.substring(0,2000)});
        }
        return r;
      };
      'ok'
    `);

    // Step 1: Find and click settings dropdown
    log('\n=== Step 1: Open settings dropdown ===');
    await evaluate(cdp, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'));
        const btn = btns.find(b => b.textContent.includes('crop_') || b.textContent.includes('Video'));
        if (btn) btn.click();
        return btn?.textContent?.trim()?.substring(0,80) || 'not found';
      })()
    `).then(r => log(`Clicked: ${r}`));
    await sleep(1000);

    // Step 2: Read ALL elements in dropdown area
    log('\n=== Step 2: Read dropdown content ===');
    const content = await evaluate(cdp, `
      (() => {
        const els = document.querySelectorAll('[role="tab"], [role="menuitem"], [role="option"], [data-state="active"], [data-state="inactive"]');
        return JSON.stringify(Array.from(els).map(e => ({
          text: e.textContent.trim().substring(0,60),
          role: e.getAttribute('role'),
          state: e.getAttribute('data-state'),
          tag: e.tagName,
          rect: { y: Math.round(e.getBoundingClientRect().y), x: Math.round(e.getBoundingClientRect().x) }
        })));
      })()
    `);
    log(`Elements: ${content}`);

    // Step 3: Try to find "Image" specifically
    log('\n=== Step 3: Click Image tab ===');
    const imageClick = await evaluate(cdp, `
      (() => {
        // Try role="tab" elements
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
        for (const t of tabs) {
          if (t.textContent.trim() === 'Image') {
            t.click();
            return 'clicked tab: Image (state=' + t.getAttribute('data-state') + ')';
          }
        }
        // Try any clickable with "Image" text
        const all = document.querySelectorAll('button, [role="menuitem"], [role="option"], [tabindex], a');
        for (const el of all) {
          if (el.textContent.trim() === 'Image') {
            el.click();
            return 'clicked: ' + el.tagName + ' ' + el.getAttribute('role');
          }
        }
        // Broader: contains Image
        for (const el of all) {
          const t = el.textContent.trim();
          if (t.includes('Image') && t.length < 15 && !t.includes('Video')) {
            el.click();
            return 'clicked broad: ' + t + ' tag=' + el.tagName;
          }
        }
        return 'Image not found. All tab texts: ' + tabs.map(t=>t.textContent.trim()).join(', ');
      })()
    `);
    log(`Image: ${imageClick}`);
    await sleep(1000);

    // Check if settings button text changed
    const settingsText = await evaluate(cdp, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const bottom = btns.filter(b => b.getBoundingClientRect().y > 500);
        return JSON.stringify(bottom.map(b => ({
          text: b.textContent.trim().substring(0,60),
          y: Math.round(b.getBoundingClientRect().y)
        })));
      })()
    `);
    log(`Bottom buttons after switch: ${settingsText}`);

    // Close dropdown
    await evaluate(cdp, `document.body.click()`);
    await sleep(500);

    // Step 4: Enter prompt and click Create
    log('\n=== Step 4: Generate image ===');
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

    // Select all + delete + type
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
    await sleep(100);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
    await sleep(200);
    await cdp.send('Input.insertText', { text: 'a cute orange cat on a windowsill with golden hour light' });
    await sleep(500);
    log('Prompt entered');

    // Click Create
    const createResult = await evaluate(cdp, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const create = btns.find(b => b.textContent.includes('Create') && b.textContent.includes('arrow_forward'));
        if (create) { create.click(); return 'clicked Create'; }
        const fallback = btns.find(b => b.textContent.includes('Create'));
        if (fallback) { fallback.click(); return 'clicked: ' + fallback.textContent.trim().substring(0,40); }
        return 'no Create. Btns: ' + btns.filter(b=>b.getBoundingClientRect().y>500).map(b=>b.textContent.trim().substring(0,30)).join('|');
      })()
    `);
    log(`Create: ${createResult}`);

    // Wait for generation
    log('Waiting 20s for API response...');
    await sleep(20000);

    // Collect results
    const apiCalls = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__apiCalls || [])`));

    log(`\n========================================`);
    log(`Captured ${apiCalls.length} API calls`);
    log(`========================================`);
    for (const call of apiCalls) {
      log(`\n--- ${call.method} ${call.url} ---`);
      log(`Status: ${call.status}`);
      if (call.req) {
        try { log(`Request:\n${JSON.stringify(JSON.parse(call.req), null, 2).substring(0, 1500)}`); }
        catch(e) { log(`Request: ${call.req.substring(0, 500)}`); }
      }
      if (call.resp) {
        try { log(`Response:\n${JSON.stringify(JSON.parse(call.resp), null, 2).substring(0, 1500)}`); }
        catch(e) { log(`Response: ${call.resp.substring(0, 500)}`); }
      }
    }

    log(`\nNetwork captures: ${netCaptures.length}`);
    for (const req of netCaptures) {
      log(`${req.method} ${req.url.substring(0, 150)}`);
      if (req.postData) log(`  ${req.postData.substring(0, 500)}`);
    }

    // Save full capture
    const fs = require('fs');
    fs.writeFileSync('scripts/flow-image-capture.json', JSON.stringify({ apiCalls, network: netCaptures }, null, 2));
    log('\nSaved to scripts/flow-image-capture.json');

  } finally {
    cdp.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
