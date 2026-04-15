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
  let page = pages.find(p => p.url.includes('flow'));
  if (!page) page = pages[0];

  const ws = await connectToPage(page.webSocketDebuggerUrl);

  // Navigate to the project page we found
  console.log('Navigating to Flow project page...');
  await sendCDP(ws, 'Page.navigate', { url: 'https://labs.google/fx/tools/flow/project/ff1af752-3ed8-46f4-86ed-740aecca9681' });
  await new Promise(r => setTimeout(r, 10000));

  const { result: u } = await sendCDP(ws, 'Runtime.evaluate', { expression: 'window.location.href' });
  const { result: t } = await sendCDP(ws, 'Runtime.evaluate', { expression: 'document.title' });
  console.log('URL:', u.value);
  console.log('Title:', t.value);

  // Full page text
  const { result: bodyText } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: 'document.body?.innerText?.substring(0, 5000) || ""'
  });
  console.log('\n=== Page Text ===');
  console.log(bodyText.value);

  // All interactive elements
  const { result: elements } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      (function() {
        function sel(el) {
          if (!el) return '';
          if (el.id) return '#' + el.id;
          let parts = [];
          let c = el;
          while (c && c.nodeType === 1 && parts.length < 5) {
            let s = c.tagName.toLowerCase();
            if (c.id) { parts.unshift('#' + c.id); break; }
            if (c.getAttribute('data-testid')) { parts.unshift('[data-testid="' + c.getAttribute('data-testid') + '"]'); break; }
            if (c.getAttribute('aria-label')) { parts.unshift('[aria-label="' + c.getAttribute('aria-label') + '"]'); break; }
            if (c.className && typeof c.className === 'string') {
              const cls = c.className.trim().split(/\\s+/).filter(x => x.length < 30 && !x.startsWith('css-')).slice(0, 2).join('.');
              if (cls) s += '.' + cls;
            }
            parts.unshift(s);
            c = c.parentElement;
          }
          return parts.join(' > ');
        }

        const textareas = Array.from(document.querySelectorAll('textarea')).filter(e => e.id !== 'g-recaptcha-response-100000').map(el => ({
          placeholder: el.placeholder || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          rows: el.rows,
          selector: sel(el),
          visible: el.getBoundingClientRect().width > 0
        }));

        const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
          type: el.type,
          placeholder: el.placeholder || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          selector: sel(el),
          visible: el.getBoundingClientRect().width > 0
        }));

        const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(el => el.getBoundingClientRect().width > 0).map(el => ({
          text: el.textContent?.trim()?.substring(0, 100) || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          title: el.title || '',
          testId: el.getAttribute('data-testid') || '',
          disabled: el.disabled,
          selector: sel(el)
        }));

        const contentEditable = Array.from(document.querySelectorAll('[contenteditable="true"]')).map(el => ({
          tag: el.tagName,
          text: el.textContent?.substring(0, 50) || '',
          selector: sel(el)
        }));

        // All divs with prompt/generate/create in class or data attributes
        const promptDivs = Array.from(document.querySelectorAll('[class*="prompt"], [class*="generate"], [class*="input"], [class*="editor"], [class*="toolbar"], [class*="panel"]')).map(el => ({
          tag: el.tagName,
          className: el.className?.substring?.(0, 100) || '',
          childCount: el.children.length,
          text: el.textContent?.trim()?.substring(0, 80) || '',
          selector: sel(el)
        })).slice(0, 20);

        // iframes
        const iframes = Array.from(document.querySelectorAll('iframe')).map(el => ({
          src: el.src?.substring(0, 150) || '',
          name: el.name || '',
          id: el.id || ''
        }));

        return JSON.stringify({ textareas, inputs, buttons, contentEditable, promptDivs, iframes }, null, 2);
      })()
    `
  });

  console.log('\n=== Interactive Elements ===');
  console.log(elements.value);

  // Get full HTML outline
  const { result: htmlOutline } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      (function() {
        function outline(el, depth) {
          if (depth > 4 || !el) return '';
          const tag = el.tagName?.toLowerCase() || '';
          const id = el.id ? '#' + el.id : '';
          const cls = el.className && typeof el.className === 'string' ?
            '.' + el.className.trim().split(/\\s+/).filter(c => c.length < 30).slice(0, 2).join('.') : '';
          const indent = '  '.repeat(depth);
          let result = indent + tag + id + cls + '\\n';
          if (el.children.length <= 20) {
            Array.from(el.children).forEach(child => {
              result += outline(child, depth + 1);
            });
          } else {
            result += indent + '  (' + el.children.length + ' children)\\n';
          }
          return result;
        }
        return outline(document.querySelector('#__next') || document.body, 0);
      })()
    `
  });

  console.log('\n=== DOM Outline ===');
  console.log(htmlOutline.value);

  ws.close();
}

main().catch(console.error);
