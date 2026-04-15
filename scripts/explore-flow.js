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
  console.log('=== All open pages ===');
  pages.forEach(p => console.log(`  ${p.url}`));

  let page = pages.find(p => p.url.includes('flow'));
  if (!page) page = pages[0];

  const ws = await connectToPage(page.webSocketDebuggerUrl);

  // Try the workspace/editor URL directly
  const urls = [
    'https://labs.google/fx/tools/flow/workspace',
    'https://labs.google/fx/tools/flow/new',
    'https://labs.google/fx/tools/flow/create/text-to-video',
    'https://labs.google/fx/tools/flow/create/video',
  ];

  for (const url of urls) {
    console.log(`\nTrying: ${url}`);
    await sendCDP(ws, 'Page.navigate', { url });
    await new Promise(r => setTimeout(r, 5000));

    const { result: u } = await sendCDP(ws, 'Runtime.evaluate', { expression: 'window.location.href' });
    const { result: t } = await sendCDP(ws, 'Runtime.evaluate', { expression: 'document.title' });
    const { result: body } = await sendCDP(ws, 'Runtime.evaluate', {
      expression: 'document.body?.innerText?.substring(0, 500) || ""'
    });
    console.log(`  Redirected to: ${u.value}`);
    console.log(`  Title: ${t.value}`);
    console.log(`  Text: ${body.value?.substring(0, 200)}`);

    // Check for textareas/inputs
    const { result: inputs } = await sendCDP(ws, 'Runtime.evaluate', {
      expression: `
        JSON.stringify({
          textareas: document.querySelectorAll('textarea').length,
          inputs: document.querySelectorAll('input').length,
          buttons: document.querySelectorAll('button').length,
          contentEditable: document.querySelectorAll('[contenteditable]').length,
          divCount: document.querySelectorAll('div').length
        })
      `
    });
    console.log(`  Elements: ${inputs.value}`);
  }

  // Also try the get-started link from pricing
  console.log('\n\nTrying Get Started link...');
  await sendCDP(ws, 'Page.navigate', { url: 'https://labs.google/fx/tools/flow' });
  await new Promise(r => setTimeout(r, 5000));

  // Get all <a> hrefs on the page
  const { result: allLinks } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `
      JSON.stringify(
        Array.from(document.querySelectorAll('a[href]')).map(a => ({
          text: a.textContent?.trim()?.substring(0, 50),
          href: a.href
        })).filter(l => l.href.includes('flow') || l.href.includes('create') || l.href.includes('workspace') || l.href.includes('editor') || l.href.includes('start'))
      )
    `
  });
  console.log('\n=== Flow-related links ===');
  console.log(allLinks.value);

  // Now get full HTML of the hero section
  const { result: heroHTML } = await sendCDP(ws, 'Runtime.evaluate', {
    expression: `document.querySelector('#hero')?.innerHTML?.substring(0, 2000) || 'no hero'`
  });
  console.log('\n=== Hero HTML ===');
  console.log(heroHTML.value);

  ws.close();
}

main().catch(console.error);
