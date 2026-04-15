// Test image generation on Flow page - intercept API calls
const WebSocket = require('ws');

const CDP_URL = 'http://127.0.0.1:9222';
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

async function getFlowPage() {
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
  const page = await getFlowPage();
  if (!page) { log('No page found'); return; }
  const cdp = await connectCDP(page);

  try {
    // Navigate to Flow
    log('Navigating to Flow...');
    await cdp.send('Page.navigate', { url: 'https://labs.google/fx/tools/flow/' });
    await sleep(5000);
    log(`URL: ${await evaluate(cdp, 'window.location.href')}`);

    // Enable network capture
    await cdp.send('Network.enable');
    const netCaptures = [];
    cdp.onEvent((method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const url = params.request.url;
        if (url.includes('googleapis.com') || url.includes('trpc')) {
          netCaptures.push({
            id: params.requestId,
            url, method: params.request.method,
            postData: params.request.postData
          });
        }
      }
    });

    // Override fetch
    await evaluate(cdp, `
      window.__apiCalls = [];
      const _f = window.__of || window.fetch;
      window.__of = _f;
      window.fetch = async function(...a) {
        const url = typeof a[0]==='string'?a[0]:a[0]?.url||'';
        const m = a[1]?.method||'GET';
        const b = a[1]?.body;
        const r = await _f.apply(this,a);
        if (url.includes('googleapis')||url.includes('trpc')||url.includes('generate')||url.includes('image')) {
          const c = r.clone();
          const t = await c.text();
          window.__apiCalls.push({url,method:m,req:typeof b==='string'?b.substring(0,2000):null,status:r.status,resp:t.substring(0,2000)});
        }
        return r;
      };
      'ok'
    `);

    // Step 1: Look at the settings dropdown for Video/Image toggle
    log('\n=== Step 1: Find media type selector ===');

    // Click the settings button (the one with crop_)
    const settingsClick = await evaluate(cdp, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'));
        const btn = btns.find(b => b.textContent.includes('crop_') || b.textContent.includes('Video'));
        if (btn) { btn.click(); return 'clicked: ' + btn.textContent.trim().substring(0,80); }
        return 'not found. buttons: ' + btns.map(b=>b.textContent.trim().substring(0,40)).join('|');
      })()
    `);
    log(`Settings: ${settingsClick}`);
    await sleep(1000);

    // Read the dropdown/popup content
    const dropdownContent = await evaluate(cdp, `
      (() => {
        // Scan all visible elements for relevant text
        const els = document.querySelectorAll('*');
        const items = [];
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const text = el.textContent?.trim();
          if (!text || text.length > 100) continue;
          if (el.children.length > 2) continue;
          const role = el.getAttribute('role');
          const state = el.getAttribute('data-state');
          if (role === 'tab' || role === 'menuitem' || role === 'option' ||
              el.tagName === 'BUTTON' || state) {
            items.push({
              text: text.substring(0,60), tag: el.tagName, role, state,
              y: Math.round(r.y), x: Math.round(r.x)
            });
          }
        }
        // Dedup
        const seen = new Set();
        return JSON.stringify(items.filter(i => {
          const k = i.text+i.role;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        }).sort((a,b) => a.y - b.y));
      })()
    `);
    log(`Dropdown items: ${dropdownContent}`);

    // Step 2: Look specifically for "Video" and "Image" tabs/options
    log('\n=== Step 2: Find Video/Image toggle ===');
    const mediaToggle = await evaluate(cdp, `
      (() => {
        const all = document.querySelectorAll('[role="tab"], [role="menuitem"], [role="option"], [data-state]');
        const found = [];
        for (const el of all) {
          const text = el.textContent.trim().toLowerCase();
          if (text === 'video' || text === 'image' || text.includes('video') || text.includes('image')) {
            found.push({
              text: el.textContent.trim(),
              tag: el.tagName,
              role: el.getAttribute('role'),
              state: el.getAttribute('data-state'),
              selected: el.getAttribute('aria-selected'),
              rect: el.getBoundingClientRect().toJSON()
            });
          }
        }
        return JSON.stringify(found);
      })()
    `);
    log(`Video/Image elements: ${mediaToggle}`);

    // Step 3: Try clicking "Image" tab/option
    log('\n=== Step 3: Switch to Image mode ===');
    const switchResult = await evaluate(cdp, `
      (() => {
        const all = document.querySelectorAll('[role="tab"], [role="menuitem"], [role="option"], button, [data-state]');
        for (const el of all) {
          const text = el.textContent.trim();
          if (text === 'Image' || text === 'image') {
            el.click();
            return 'clicked: ' + text + ' (role=' + el.getAttribute('role') + ', tag=' + el.tagName + ')';
          }
        }
        // Try broader search
        for (const el of all) {
          const text = el.textContent.trim().toLowerCase();
          if (text.includes('image') && !text.includes('video') && text.length < 20) {
            el.click();
            return 'clicked broader: ' + el.textContent.trim();
          }
        }
        return 'no Image option found';
      })()
    `);
    log(`Switch: ${switchResult}`);
    await sleep(1000);

    // Check if UI changed
    const afterSwitch = await evaluate(cdp, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'));
        const btn = btns.find(b => b.textContent.includes('crop_') || b.textContent.includes('Image') || b.textContent.includes('Video'));
        return btn ? btn.textContent.trim().substring(0,80) : 'no settings btn';
      })()
    `);
    log(`Settings button after switch: ${afterSwitch}`);

    // Close dropdown
    await evaluate(cdp, `document.body.click()`);
    await sleep(500);

    // Step 4: Type a prompt and generate
    log('\n=== Step 4: Enter prompt and generate ===');
    netCaptures.length = 0;
    await evaluate(cdp, `window.__apiCalls = []`);

    // Focus prompt area
    await evaluate(cdp, `
      (() => {
        const el = document.querySelector('[contenteditable="true"], [data-slate-editor], textarea, [role="textbox"]');
        if (el) { el.focus(); el.click(); return 'focused'; }
        return 'no input';
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
    await cdp.send('Input.insertText', { text: 'a cute orange cat on a windowsill' });
    await sleep(500);

    // Click Create button
    log('Clicking Create...');
    const createClick = await evaluate(cdp, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const create = btns.find(b => {
          const text = b.textContent.trim();
          return text.includes('Create') && text.includes('arrow_forward');
        });
        if (create) {
          create.click();
          return 'clicked Create';
        }
        // Fallback: any button with Create
        const fallback = btns.find(b => b.textContent.includes('Create'));
        if (fallback) {
          fallback.click();
          return 'clicked fallback Create: ' + fallback.textContent.trim().substring(0,40);
        }
        return 'no Create button. Buttons: ' + btns.map(b=>b.textContent.trim().substring(0,30)).filter(t=>t).join('|');
      })()
    `);
    log(`Create: ${createClick}`);

    // Wait for API calls
    log('Waiting 20s for API response...');
    await sleep(20000);

    // Collect results
    const apiCalls = await evaluate(cdp, `JSON.stringify(window.__apiCalls || [])`);
    const calls = JSON.parse(apiCalls);

    log(`\n=== Captured ${calls.length} API calls ===`);
    for (const call of calls) {
      log(`\n--- ${call.method} ${call.url} ---`);
      log(`Status: ${call.status}`);
      if (call.req) {
        try {
          const parsed = JSON.parse(call.req);
          log(`Request: ${JSON.stringify(parsed, null, 2).substring(0, 1000)}`);
        } catch(e) {
          log(`Request: ${call.req.substring(0, 500)}`);
        }
      }
      if (call.resp) {
        try {
          const parsed = JSON.parse(call.resp);
          log(`Response: ${JSON.stringify(parsed, null, 2).substring(0, 1000)}`);
        } catch(e) {
          log(`Response: ${call.resp.substring(0, 500)}`);
        }
      }
    }

    log(`\n=== Network captures: ${netCaptures.length} ===`);
    for (const req of netCaptures) {
      log(`${req.method} ${req.url.substring(0, 150)}`);
      if (req.postData) log(`  Body: ${req.postData.substring(0, 500)}`);
    }

    // Save
    const fs = require('fs');
    fs.writeFileSync('scripts/flow-image-api-capture.json', JSON.stringify({ apiCalls: calls, network: netCaptures }, null, 2));
    log('\nSaved to scripts/flow-image-api-capture.json');

  } finally {
    cdp.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
