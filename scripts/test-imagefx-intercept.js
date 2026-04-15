// Navigate to ImageFX page and intercept its API calls
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
    const events = [];
    let eventHandler = null;
    ws.on('open', () => {
      const cdp = {
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const msgId = id++;
            pending.set(msgId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        onEvent(handler) { eventHandler = handler; },
        close() { ws.close(); }
      };
      resolve(cdp);
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
    // Enable network interception
    await cdp.send('Network.enable');

    const apiRequests = [];
    cdp.onEvent((method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const url = params.request.url;
        // Capture API-like requests
        if (url.includes('googleapis.com') || url.includes('/api/trpc/') || url.includes('aisandbox')) {
          apiRequests.push({
            url: url,
            method: params.request.method,
            postData: params.request.postData?.substring(0, 500),
            type: params.type
          });
        }
      }
    });

    // Navigate to ImageFX
    log('Navigating to ImageFX...');
    await cdp.send('Page.navigate', { url: 'https://labs.google/fx/tools/image-fx' });
    await sleep(5000);

    // Check current URL
    const currentUrl = await evaluate(cdp, `window.location.href`);
    log(`Current URL: ${currentUrl}`);

    // Log captured requests so far
    log(`\nCaptured ${apiRequests.length} API requests during page load:`);
    for (const req of apiRequests) {
      log(`  ${req.method} ${req.url.substring(0, 150)}`);
      if (req.postData) log(`    Body: ${req.postData.substring(0, 200)}`);
    }

    // Check what's on the ImageFX page
    log('\n=== ImageFX page content ===');
    const pageContent = await evaluate(cdp, `
      (() => {
        const inputs = document.querySelectorAll('input, textarea, [contenteditable]');
        const buttons = document.querySelectorAll('button');
        return JSON.stringify({
          title: document.title,
          inputs: Array.from(inputs).map(i => ({
            tag: i.tagName,
            type: i.type,
            placeholder: i.placeholder,
            role: i.getAttribute('role'),
            ariaLabel: i.getAttribute('aria-label'),
            contentEditable: i.contentEditable
          })),
          buttons: Array.from(buttons).map(b => ({
            text: b.textContent.trim().substring(0, 60),
            ariaLabel: b.getAttribute('aria-label')
          })).filter(b => b.text.length > 0).slice(0, 20)
        });
      })()
    `);
    log(pageContent);

    // Now try to generate an image via the UI
    log('\n=== Try to input prompt and generate ===');

    // Find and fill prompt input
    const promptFilled = await evaluate(cdp, `
      (() => {
        // Try textarea first
        const textarea = document.querySelector('textarea');
        if (textarea) {
          textarea.value = 'a cute cat sitting on a windowsill with sunset light';
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return 'textarea: ' + textarea.value;
        }
        // Try contenteditable
        const ce = document.querySelector('[contenteditable="true"]');
        if (ce) {
          ce.textContent = 'a cute cat sitting on a windowsill with sunset light';
          ce.dispatchEvent(new Event('input', { bubbles: true }));
          return 'contenteditable: ' + ce.textContent;
        }
        // Try Slate editor
        const slate = document.querySelector('[data-slate-editor]');
        if (slate) {
          return 'slate found but needs special input';
        }
        return 'no input found';
      })()
    `);
    log(`Prompt input: ${promptFilled}`);

    // If it's a Slate editor, use insertText
    if (promptFilled.includes('slate') || promptFilled === 'no input found') {
      // Click on the input area first
      await evaluate(cdp, `
        (() => {
          const el = document.querySelector('[contenteditable="true"], [data-slate-editor], textarea, [role="textbox"]');
          if (el) { el.click(); el.focus(); return 'focused'; }
          return 'no element';
        })()
      `);
      await sleep(300);

      // Use CDP insertText
      await cdp.send('Input.insertText', { text: 'a cute cat sitting on a windowsill with sunset light' });
      log('Used CDP insertText');
      await sleep(500);
    }

    // Clear captured requests before clicking generate
    apiRequests.length = 0;

    // Find and click generate button
    const generateClicked = await evaluate(cdp, `
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        // Look for generate/create button
        const genBtn = buttons.find(b => {
          const text = b.textContent.toLowerCase();
          return text.includes('generate') || text.includes('create') || text.includes('arrow_forward');
        });
        if (genBtn) {
          genBtn.click();
          return 'clicked: ' + genBtn.textContent.trim().substring(0, 60);
        }
        return 'no generate button found. Buttons: ' + buttons.map(b => b.textContent.trim().substring(0, 40)).join(' | ');
      })()
    `);
    log(`Generate button: ${generateClicked}`);

    // Wait for API calls
    log('\nWaiting 15s for API calls...');
    await sleep(15000);

    log(`\nCaptured ${apiRequests.length} API requests after clicking generate:`);
    for (const req of apiRequests) {
      log(`\n  ${req.method} ${req.url}`);
      if (req.postData) log(`  Body: ${req.postData}`);
    }

    // Check for any XHR/fetch to image APIs
    const fetchHistory = await evaluate(cdp, `
      (() => {
        // Check performance entries for API calls
        const entries = performance.getEntriesByType('resource')
          .filter(e => e.name.includes('googleapis') || e.name.includes('trpc') || e.name.includes('aisandbox'))
          .map(e => ({ url: e.name, duration: Math.round(e.duration) }));
        return JSON.stringify(entries.slice(-30));
      })()
    `);
    log(`\nPerformance entries: ${fetchHistory}`);

  } finally {
    cdp.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
