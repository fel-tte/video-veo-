// Connect to Chrome CDP and inspect labs.google for Veo3 elements
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
    const timeout = setTimeout(() => reject(new Error('CDP timeout')), 15000);
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
  // First navigate to labs.google
  const pages = await getPages();

  // Find or create a labs.google page
  let targetPage = pages.find(p => p.url.includes('labs.google'));
  let wsUrl;

  if (targetPage) {
    wsUrl = targetPage.webSocketDebuggerUrl;
    console.log('Found existing labs.google page:', targetPage.url);
  } else {
    // Use the first page and navigate
    wsUrl = pages[0].webSocketDebuggerUrl;
    console.log('Navigating first page to labs.google...');
  }

  const ws = await connectToPage(wsUrl);
  console.log('Connected to CDP');

  // Navigate to labs.google
  if (!targetPage) {
    await sendCDP(ws, 'Page.navigate', { url: 'https://labs.google/' });
    await new Promise(r => setTimeout(r, 5000));
  }

  // Wait a bit for page load
  await new Promise(r => setTimeout(r, 2000));

  // Get current URL
  const { result: urlResult } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: 'window.location.href'
  });
  console.log('\n=== Current URL ===');
  console.log(urlResult.value);

  // Get page title
  const { result: titleResult } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: 'document.title'
  });
  console.log('\n=== Page Title ===');
  console.log(titleResult.value);

  // Get full page HTML structure overview
  const { result: bodyOverview } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      (function() {
        // Find all interactive elements
        const inputs = Array.from(document.querySelectorAll('input, textarea')).map(el => ({
          tag: el.tagName,
          type: el.type || '',
          placeholder: el.placeholder || '',
          name: el.name || '',
          id: el.id || '',
          className: el.className?.substring?.(0, 100) || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          selector: getSelector(el)
        }));

        const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map(el => ({
          tag: el.tagName,
          text: el.textContent?.trim()?.substring(0, 80) || '',
          id: el.id || '',
          className: el.className?.substring?.(0, 100) || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          disabled: el.disabled || false,
          selector: getSelector(el)
        }));

        const links = Array.from(document.querySelectorAll('a[href]')).filter(a =>
          a.textContent?.toLowerCase().includes('veo') ||
          a.href?.toLowerCase().includes('veo') ||
          a.textContent?.toLowerCase().includes('video') ||
          a.href?.toLowerCase().includes('video')
        ).map(el => ({
          text: el.textContent?.trim()?.substring(0, 80) || '',
          href: el.href || '',
          selector: getSelector(el)
        }));

        function getSelector(el) {
          if (el.id) return '#' + el.id;
          let path = [];
          while (el && el.nodeType === 1) {
            let selector = el.tagName.toLowerCase();
            if (el.id) { path.unshift('#' + el.id); break; }
            if (el.className && typeof el.className === 'string') {
              const cls = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
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

        return JSON.stringify({ inputs, buttons, links }, null, 2);
      })()
    `
  });

  console.log('\n=== Interactive Elements ===');
  console.log(bodyOverview.value);

  // Look for Veo3 specific content
  const { result: veoContent } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      (function() {
        const allText = document.body.innerText;
        const veoMentions = [];
        const lines = allText.split('\\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line && (line.toLowerCase().includes('veo') || line.toLowerCase().includes('video') || line.toLowerCase().includes('generate') || line.toLowerCase().includes('prompt') || line.toLowerCase().includes('create'))) {
            veoMentions.push(line.substring(0, 120));
          }
        }
        return JSON.stringify(veoMentions.slice(0, 30), null, 2);
      })()
    `
  });

  console.log('\n=== Veo/Video/Generate Related Text ===');
  console.log(veoContent.value);

  // Check for shadow DOM elements (common in Google's web components)
  const { result: shadowCheck } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      (function() {
        const shadowHosts = [];
        function findShadowRoots(el, depth) {
          if (depth > 5) return;
          if (el.shadowRoot) {
            shadowHosts.push({
              tag: el.tagName.toLowerCase(),
              id: el.id || '',
              className: (el.className?.substring?.(0, 60) || ''),
              childCount: el.shadowRoot.children.length,
              innerText: el.shadowRoot.textContent?.substring(0, 100) || ''
            });
            Array.from(el.shadowRoot.children).forEach(c => findShadowRoots(c, depth + 1));
          }
          Array.from(el.children || []).forEach(c => findShadowRoots(c, depth + 1));
        }
        findShadowRoots(document.body, 0);
        return JSON.stringify(shadowHosts.slice(0, 20), null, 2);
      })()
    `
  });

  console.log('\n=== Shadow DOM Elements ===');
  console.log(shadowCheck.value);

  ws.close();
  console.log('\nDone inspecting.');
}

main().catch(console.error);
