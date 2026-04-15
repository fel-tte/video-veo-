const WebSocket = require('ws');
const http = require('http');

async function run() {
  const res = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });

  // Check ALL pages
  const allPages = res.filter(p => p.type === 'page');
  console.log(`Total pages: ${allPages.length}`);
  allPages.forEach(p => console.log(`  ${p.url}`));

  const page = allPages[0];
  if (!page) { console.log('No page'); return; }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));

  function send(method, params = {}) {
    const id = Math.floor(Math.random() * 99999);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 10000);
      function h(m) {
        const d = JSON.parse(m);
        if (d.id === id) { clearTimeout(t); ws.removeListener('message', h); resolve(d.result); }
      }
      ws.on('message', h);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Get ALL cookies including google.com domain
  const cookieResult = await send('Network.getCookies', {
    urls: ['https://labs.google', 'https://accounts.google.com', 'https://www.google.com', 'https://labs.google/fx']
  });
  const cookies = cookieResult.cookies || [];
  console.log(`\nTotal cookies: ${cookies.length}`);
  const authCookies = cookies.filter(c =>
    c.name.includes('SID') || c.name.startsWith('__Secure') || c.name === 'NID' ||
    c.name === 'APISID' || c.name === 'SAPISID' || c.name === 'HSID' || c.name === 'SSID'
  );
  console.log(`Auth cookies: ${authCookies.length}`);
  authCookies.forEach(c => console.log(`  ${c.name} (${c.domain}) = ${c.value.substring(0, 20)}...`));

  // Get full page text
  const evalResult = await send('Runtime.evaluate', {
    expression: `(function(){
      var url = window.location.href;
      var body = document.body ? document.body.innerText : '';
      var editor = document.querySelector("div[contenteditable='true']");
      var buttons = Array.from(document.querySelectorAll('button, a')).filter(function(el){
        return el.textContent && el.textContent.trim().length > 0 && el.textContent.trim().length < 50;
      }).map(function(el) {
        var r = el.getBoundingClientRect();
        return { tag: el.tagName, text: el.textContent.trim().substring(0, 40), href: el.href || '', visible: r.width > 0 && r.height > 0, x: Math.round(r.x), y: Math.round(r.y) };
      });
      return JSON.stringify({
        url: url,
        hasEditor: !!editor,
        bodyLength: body.length,
        bodyFirst500: body.substring(0, 500),
        bodyLast500: body.substring(body.length - 500),
        interactiveElements: buttons.filter(function(b){ return b.visible; }).slice(0, 30)
      });
    })()`,
    returnByValue: true
  });

  const state = JSON.parse(evalResult.result.value);
  console.log(`\nURL: ${state.url}`);
  console.log(`Editor: ${state.hasEditor}`);
  console.log(`Body length: ${state.bodyLength}`);
  console.log(`\nFirst 500 chars:\n${state.bodyFirst500}`);
  console.log(`\nVisible buttons/links:`);
  state.interactiveElements.forEach(e => console.log(`  [${e.tag}] "${e.text}" at (${e.x},${e.y}) ${e.href ? 'href=' + e.href.substring(0, 60) : ''}`));

  ws.close();
}
run().catch(e => console.error('Error:', e.message));
