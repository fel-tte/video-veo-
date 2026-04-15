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

async function main() {
  const pages = await getPages();
  let targetPage = pages.find(p => p.url.includes('labs.google'));
  if (!targetPage) targetPage = pages[0];

  const ws = await connectToPage(targetPage.webSocketDebuggerUrl);
  console.log('Connected, navigating to Veo3 video FX page...');

  // Navigate to the video generation page
  await sendCDP(ws, 'Page.navigate', { url: 'https://labs.google/fx/tools/video-fx' });
  await new Promise(r => setTimeout(r, 8000));

  // Check URL
  const { result: urlResult } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: 'window.location.href'
  });
  console.log('\n=== URL ===');
  console.log(urlResult.value);

  // Check title
  const { result: titleResult } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: 'document.title'
  });
  console.log('Title:', titleResult.value);

  // Get ALL interactive elements on the page
  const { result: elements } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      (function() {
        function getSelector(el) {
          if (el.id) return '#' + el.id;
          let path = [];
          while (el && el.nodeType === 1) {
            let selector = el.tagName.toLowerCase();
            if (el.id) { path.unshift('#' + el.id); break; }
            if (el.className && typeof el.className === 'string') {
              const cls = el.className.trim().split(/\\s+/).slice(0, 3).join('.');
              if (cls) selector += '.' + cls;
            }
            const parent = el.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
              if (siblings.length > 1) {
                const idx = siblings.indexOf(el) + 1;
                selector += ':nth-of-type(' + idx + ')';
              }
            }
            path.unshift(selector);
            el = el.parentElement;
          }
          return path.join(' > ');
        }

        // Textareas and inputs
        const textareas = Array.from(document.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')).map(el => ({
          tag: el.tagName,
          type: el.type || '',
          placeholder: el.placeholder || el.getAttribute('placeholder') || '',
          value: el.value?.substring(0, 50) || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          id: el.id || '',
          selector: getSelector(el),
          visible: el.offsetParent !== null
        }));

        // Buttons
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).map(el => ({
          tag: el.tagName,
          text: el.textContent?.trim()?.substring(0, 100) || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          id: el.id || '',
          disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
          selector: getSelector(el),
          visible: el.offsetParent !== null
        })).filter(b => b.visible);

        // Links with veo/video
        const veoLinks = Array.from(document.querySelectorAll('a')).filter(a => {
          const text = (a.textContent || '').toLowerCase();
          const href = (a.href || '').toLowerCase();
          return text.includes('veo') || href.includes('veo') || text.includes('video') || href.includes('video') || text.includes('generate') || text.includes('create');
        }).map(el => ({
          text: el.textContent?.trim()?.substring(0, 100) || '',
          href: el.href || '',
          selector: getSelector(el)
        }));

        // Also look for any mat- components (Angular Material)
        const matElements = Array.from(document.querySelectorAll('[class*="mat-"], mat-form-field, mat-input, mat-button')).map(el => ({
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim()?.substring(0, 80) || '',
          className: el.className?.substring?.(0, 120) || '',
          id: el.id || ''
        })).slice(0, 20);

        // Page text content (key sections)
        const pageText = document.body.innerText?.substring(0, 3000) || '';

        return JSON.stringify({ textareas, buttons, veoLinks, matElements, pageText }, null, 2);
      })()
    `
  });

  console.log('\n=== Page Elements ===');
  console.log(elements.value);

  ws.close();
}

main().catch(console.error);
