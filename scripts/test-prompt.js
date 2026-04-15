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
  console.log('Pages:', pages.map(p => p.url));

  // Find the Flow project page
  let page = pages.find(p => p.url.includes('flow/project'));
  if (!page) {
    page = pages.find(p => p.url.includes('flow'));
    if (!page) page = pages[0];
  }

  const ws = await connectToPage(page.webSocketDebuggerUrl);
  console.log('Connected to:', page.url);

  // If not on project page, navigate there
  if (!page.url.includes('flow/project')) {
    console.log('Navigating to create page...');
    await sendCDP(ws, 'Page.navigate', { url: 'https://labs.google/fx/tools/flow/create' });
    await new Promise(r => setTimeout(r, 8000));
  }

  // Check current URL
  const { result: url } = await sendCDP(ws, 'Runtime.evaluate', { expression: 'window.location.href' });
  console.log('Current URL:', url.value);

  // Check for contenteditable (prompt input)
  const { result: hasInput } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      (function() {
        const ce = document.querySelector("div[contenteditable='true']");
        if (!ce) return { found: false };
        const rect = ce.getBoundingClientRect();
        return {
          found: true,
          text: ce.textContent?.substring(0, 100),
          width: rect.width,
          height: rect.height,
          visible: rect.width > 0
        };
      })()
    `,
    returnByValue: true
  });
  console.log('\n=== Prompt Input ===');
  console.log(JSON.stringify(hasInput.value, null, 2));

  // Check for Create button
  const { result: createBtn } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      (function() {
        const buttons = document.querySelectorAll('button, [role="button"]');
        const matches = [];
        for (const btn of buttons) {
          const text = btn.textContent?.trim() || '';
          if (text.includes('Create') && btn.getBoundingClientRect().width > 0) {
            matches.push({
              text: text.substring(0, 80),
              disabled: btn.disabled,
              rect: { w: Math.round(btn.getBoundingClientRect().width), h: Math.round(btn.getBoundingClientRect().height) }
            });
          }
        }
        return matches;
      })()
    `,
    returnByValue: true
  });
  console.log('\n=== Create Buttons ===');
  console.log(JSON.stringify(createBtn.value, null, 2));

  // Check for model selector
  const { result: modelInfo } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      (function() {
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
          const text = btn.textContent?.trim() || '';
          if ((text.includes('Nano') || text.includes('Veo') || text.includes('Banana')) && btn.getBoundingClientRect().width > 0) {
            return { text: text.substring(0, 100), found: true };
          }
        }
        return { found: false };
      })()
    `,
    returnByValue: true
  });
  console.log('\n=== Model Selector ===');
  console.log(JSON.stringify(modelInfo.value, null, 2));

  // Check existing media count
  const { result: mediaCount } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `document.querySelectorAll('[id^="fe_id_"]').length`
  });
  console.log('\n=== Media Items ===');
  console.log('Count:', mediaCount.value);

  // Check login state
  const { result: loginCheck } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `document.body.innerText.includes('What do you want to create')`
  });
  console.log('\n=== Logged In ===');
  console.log(loginCheck.value);

  console.log('\n=== SUMMARY ===');
  console.log('Prompt input found:', hasInput.value?.found);
  console.log('Create button found:', createBtn.value?.length > 0);
  console.log('Model selector found:', modelInfo.value?.found);
  console.log('Logged in:', loginCheck.value);
  console.log('Existing media:', mediaCount.value);

  ws.close();
}

main().catch(console.error);
