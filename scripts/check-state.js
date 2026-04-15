const WebSocket = require('ws');
const http = require('http');

async function run() {
  const res = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });

  const page = res.find(p => p.url.includes('labs.google') && p.type === 'page');
  if (!page) { console.log('No labs.google page'); return; }

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

  // 1. Check cookies
  const cookieResult = await send('Network.getCookies', { urls: ['https://labs.google'] });
  const cookies = cookieResult.cookies || [];
  const authCookies = cookies.filter(c => c.name.includes('SID') || c.name.startsWith('__Secure'));
  console.log(`Auth cookies: ${authCookies.length}`);
  authCookies.forEach(c => console.log(`  ${c.name} (${c.domain})`));

  // 2. Check page content
  const evalResult = await send('Runtime.evaluate', {
    expression: `(function(){
      var editor = document.querySelector("div[contenteditable='true']");
      var links = Array.from(document.querySelectorAll('a')).filter(function(a){ return a.href.indexOf('flow') > -1; }).map(function(a){ return {href: a.href, text: a.textContent.trim().substring(0,50)}; });
      var body = document.body ? document.body.innerText.substring(0,800) : 'no body';
      return JSON.stringify({ url: window.location.href, hasEditor: !!editor, flowLinks: links.slice(0,10), bodyPreview: body });
    })()`,
    returnByValue: true
  });

  const state = JSON.parse(evalResult.result.value);
  console.log('\nURL:', state.url);
  console.log('Has editor:', state.hasEditor);
  console.log('Flow links:', JSON.stringify(state.flowLinks, null, 2));
  console.log('\nBody preview:', state.bodyPreview.substring(0, 500));

  ws.close();
}
run().catch(e => console.error('Error:', e.message));
