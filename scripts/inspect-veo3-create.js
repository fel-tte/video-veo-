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
  let targetPage = pages.find(p => p.url.includes('labs.google') || p.url.includes('flow'));
  if (!targetPage) targetPage = pages[0];

  const ws = await connectToPage(targetPage.webSocketDebuggerUrl);
  console.log('Connected to:', targetPage.url);

  // Navigate to the create/workspace page
  await sendCDP(ws, 'Page.navigate', { url: 'https://labs.google/fx/tools/flow/create' });
  console.log('Navigating to create page...');
  await new Promise(r => setTimeout(r, 10000));

  let { result: urlResult } = await sendCDP(ws, 'Runtime.evaluate', { expression: 'window.location.href' });
  console.log('URL after navigate:', urlResult.value);

  // If that didn't work, try clicking the button
  if (!urlResult.value.includes('create')) {
    console.log('Trying direct flow URL...');
    await sendCDP(ws, 'Page.navigate', { url: 'https://labs.google/fx/tools/flow' });
    await new Promise(r => setTimeout(r, 5000));

    // Click "Create with Flow" button
    await sendCDP(ws, 'Runtime.evaluate', {
      expression: `
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Create with Flow'));
        if (btn) { btn.click(); 'clicked'; } else { 'not found'; }
      `
    });
    await new Promise(r => setTimeout(r, 8000));

    // Check for new pages
    ws.close();
    const newPages = await getPages();
    console.log('\n=== All Pages After Click ===');
    newPages.forEach(p => console.log(`  ${p.url} - ${p.title}`));

    // Find the create/workspace page
    const createPage = newPages.find(p =>
      p.url.includes('create') || p.url.includes('workspace') ||
      p.url.includes('editor') || p.url.includes('app')
    ) || newPages.find(p => p.url.includes('flow') && p.url !== targetPage.url) || newPages[newPages.length - 1];

    const ws2 = await connectToPage(createPage.webSocketDebuggerUrl);
    console.log('\nConnected to:', createPage.url);
    await new Promise(r => setTimeout(r, 5000));

    await inspectPage(ws2);
    ws2.close();
  } else {
    await inspectPage(ws);
    ws.close();
  }
}

async function inspectPage(ws) {
  const { result: urlResult } = await sendCDP(ws, 'Runtime.evaluate', { expression: 'window.location.href' });
  console.log('\n=== Current URL ===');
  console.log(urlResult.value);

  const { result: titleResult } = await sendCDP(ws, 'Runtime.evaluate', { expression: 'document.title' });
  console.log('Title:', titleResult.value);

  // Get ALL elements comprehensively
  const { result } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      (function() {
        function getSelector(el) {
          if (el.id) return '#' + el.id;
          let path = [];
          let current = el;
          while (current && current.nodeType === 1 && path.length < 6) {
            let selector = current.tagName.toLowerCase();
            if (current.id) { path.unshift('#' + current.id); break; }
            if (current.className && typeof current.className === 'string') {
              const cls = current.className.trim().split(/\\s+/).filter(c => !c.startsWith('ng-') && c.length < 40).slice(0, 2).join('.');
              if (cls) selector += '.' + cls;
            }
            path.unshift(selector);
            current = current.parentElement;
          }
          return path.join(' > ');
        }

        // All textareas and text inputs
        const textInputs = Array.from(document.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]')).map(el => ({
          tag: el.tagName,
          type: el.type || el.getAttribute('role') || '',
          placeholder: el.placeholder || el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          id: el.id || '',
          selector: getSelector(el),
          visible: el.offsetParent !== null || el.offsetWidth > 0,
          rect: el.getBoundingClientRect ? {w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height} : null
        }));

        // All visible buttons
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }).map(el => ({
          text: el.textContent?.trim()?.substring(0, 80) || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          title: el.title || '',
          disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
          selector: getSelector(el),
          rect: {w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height)}
        }));

        // All select/dropdown elements
        const selects = Array.from(document.querySelectorAll('select, [role="listbox"], [role="combobox"]')).map(el => ({
          tag: el.tagName,
          id: el.id || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          selector: getSelector(el)
        }));

        // Look for video-related elements
        const videoEls = Array.from(document.querySelectorAll('video, [class*="video"], [class*="player"], [class*="preview"]')).map(el => ({
          tag: el.tagName,
          src: el.src?.substring(0, 100) || '',
          className: el.className?.substring?.(0, 80) || '',
          selector: getSelector(el)
        })).slice(0, 10);

        // Get page text (first 4000 chars)
        const pageText = document.body?.innerText?.substring(0, 4000) || '';

        return JSON.stringify({ textInputs, buttons, selects, videoEls, pageText }, null, 2);
      })()
    `
  });

  console.log('\n=== Page Elements ===');
  console.log(result.value);
}

main().catch(console.error);
