/**
 * Passive API capture: just listen to all network traffic for 60s while user browses.
 * Also extracts access_token from __NEXT_DATA__
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

function send(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 99999);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
    function h(m) {
      const d = JSON.parse(m);
      if (d.id === id) { clearTimeout(t); ws.removeListener('message', h); if (d.error) reject(new Error(d.error.message)); else resolve(d.result); }
    }
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJS(ws, expr) {
  const { result } = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (result.subtype === 'error') throw new Error(result.description);
  return result.value;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

async function cdpClick(ws, x, y) {
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(80);
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(40);
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function main() {
  const pages = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });

  const target = pages.find(p => p.url.includes('labs.google') && p.type === 'page');
  if (!target) { console.error('No labs.google page'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));

  const url = await evalJS(ws, 'window.location.href');
  log(`Connected: ${url}`);

  // Extract tokens
  log('\n=== TOKENS ===');
  const tokenData = await evalJS(ws, `(function(){
    var result = {};
    if (window.__NEXT_DATA__) {
      var nd = window.__NEXT_DATA__;
      var session = nd.props && nd.props.pageProps && nd.props.pageProps.session;
      if (session) {
        result.access_token = session.access_token;
        result.expires = session.expires;
        result.user = session.user;
      }
    }
    return JSON.stringify(result);
  })()`);
  const tkns = JSON.parse(tokenData);
  log(`Access token: ${tkns.access_token ? tkns.access_token.substring(0, 50) + '...' : 'not found'}`);
  log(`Expires: ${tkns.expires}`);
  log(`User: ${JSON.stringify(tkns.user)}`);

  // Get cookies
  const cookies = await send(ws, 'Network.getCookies', { urls: ['https://labs.google', 'https://labs.google/fx'] });
  const cookieList = cookies.cookies || [];
  const sapisid = cookieList.find(c => c.name === 'SAPISID');

  // Enable network capture
  log('\n=== ENABLING NETWORK CAPTURE ===');
  await send(ws, 'Network.enable');

  const captured = [];
  const responseMap = {};

  ws.on('message', (rawMsg) => {
    try {
      const data = JSON.parse(rawMsg);

      if (data.method === 'Network.requestWillBeSent') {
        const req = data.params;
        const u = req.request.url;
        if ((u.includes('labs.google') && (u.includes('/api/') || u.includes('trpc'))) ||
            u.includes('alkali') || u.includes('generativelanguage') || u.includes('googleapis')) {
          captured.push({
            id: req.requestId,
            method: req.request.method,
            url: u,
            headers: req.request.headers,
            postData: req.request.postData || null,
            ts: Date.now()
          });
          log(`>>> ${req.request.method} ${u.length > 150 ? u.substring(0, 150) + '...' : u}`);
          if (req.request.postData) {
            try { log(`    BODY: ${JSON.stringify(JSON.parse(req.request.postData)).substring(0, 600)}`); }
            catch { log(`    BODY: ${req.request.postData.substring(0, 400)}`); }
          }
        }
      }

      if (data.method === 'Network.responseReceived') {
        const resp = data.params;
        const u = resp.response.url;
        if ((u.includes('labs.google') && (u.includes('/api/') || u.includes('trpc'))) ||
            u.includes('alkali') || u.includes('generativelanguage') || u.includes('googleapis')) {
          responseMap[resp.requestId] = {
            status: resp.response.status,
            headers: resp.response.headers,
            mimeType: resp.response.mimeType
          };
          log(`<<< ${resp.response.status} ${u.length > 150 ? u.substring(0, 150) + '...' : u}`);
        }
      }
    } catch (e) { /* ignore */ }
  });

  // Now let's trigger some API activity: type a prompt and submit
  await sleep(2000);

  // Check if editor exists
  const hasEditor = await evalJS(ws, `!!document.querySelector("div[contenteditable='true']")`);
  if (hasEditor) {
    log('\n=== TYPING PROMPT ===');
    // Focus editor
    const editorPos = await evalJS(ws, `(function(){
      var ce = document.querySelector("div[contenteditable='true']");
      var r = ce.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + 10), y: Math.round(r.top + r.height/2) });
    })()`);
    const ep = JSON.parse(editorPos);
    await cdpClick(ws, ep.x, ep.y);
    await sleep(500);
    await send(ws, 'Input.insertText', { text: 'A tiny fox exploring a magical forest, cinematic 4K' });
    await sleep(1000);

    // Find Create button - more flexible search
    const createBtn = await evalJS(ws, `(function(){
      var btns = document.querySelectorAll('button');
      var candidates = [];
      for (var i = 0; i < btns.length; i++) {
        var t = btns[i].textContent || '';
        var r = btns[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          if (t.indexOf('Create') > -1 && t.indexOf('arrow_forward') > -1) {
            candidates.push({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: t.trim().substring(0, 40), w: r.width, h: r.height });
          }
        }
      }
      return JSON.stringify(candidates);
    })()`);

    const btns = JSON.parse(createBtn);
    log(`Create buttons found: ${btns.length}`);
    btns.forEach(b => log(`  "${b.text}" at (${b.x},${b.y}) ${b.w}x${b.h}`));

    if (btns.length > 0) {
      // Pick the last one (most likely the submit button)
      const btn = btns[btns.length - 1];
      log(`Clicking: "${btn.text}" at (${btn.x}, ${btn.y})`);
      await cdpClick(ws, btn.x, btn.y);

      // Wait for generation
      log('\n=== WAITING FOR GENERATION (5 min max) ===');
      const initialCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
      const startTime = Date.now();

      while (Date.now() - startTime < 5 * 60 * 1000) {
        await sleep(5000);
        const count = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        log(`[${elapsed}s] media=${count}/${initialCount} captured=${captured.length}`);
        if (count > initialCount) {
          log('Generation complete!');
          await sleep(5000);
          break;
        }
      }
    } else {
      log('No Create button found, waiting 30s for passive capture...');
      await sleep(30000);
    }
  } else {
    log('No editor, waiting 30s for passive capture...');
    await sleep(30000);
  }

  // Get response bodies
  log('\n=== RESPONSE BODIES ===');
  for (const req of captured) {
    try {
      const body = await send(ws, 'Network.getResponseBody', { requestId: req.id });
      req.responseBody = body.body;
      req.responseBase64 = body.base64Encoded;
      if (req.responseBody && !body.base64Encoded) {
        log(`RESP ${req.url.substring(0, 100)}:`);
        log(`  ${req.responseBody.substring(0, 500)}`);
      }
    } catch (e) { /* not available */ }
  }

  // Save report
  const report = {
    timestamp: new Date().toISOString(),
    pageUrl: url,
    tokens: tkns,
    sapisid: sapisid ? sapisid.value : null,
    cookies: {
      all: cookieList.map(c => ({ name: c.name, domain: c.domain, value: c.value, httpOnly: c.httpOnly, secure: c.secure })),
      fullString: cookieList.map(c => `${c.name}=${c.value}`).join('; ')
    },
    requests: captured.map(r => ({
      method: r.method,
      url: r.url,
      headers: r.headers,
      postData: r.postData,
      response: responseMap[r.id] || null,
      responseBody: r.responseBody ? r.responseBody.substring(0, 20000) : null
    })),
    summary: {
      total: captured.length,
      endpoints: [...new Set(captured.map(r => {
        try { const u = new URL(r.url); return `${r.method} ${u.pathname}`; }
        catch { return r.url.substring(0, 80); }
      }))]
    }
  };

  fs.writeFileSync('c:/Users/Admin/Desktop/veo3/scripts/api-capture.json', JSON.stringify(report, null, 2));
  log('\nSaved to scripts/api-capture.json');

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Access token: ${tkns.access_token ? 'YES (ya29...)' : 'NO'}`);
  console.log(`SAPISID: ${sapisid ? 'YES' : 'NO'}`);
  console.log(`Cookies: ${cookieList.length}`);
  console.log(`API calls captured: ${captured.length}`);
  console.log('\nEndpoints:');
  report.summary.endpoints.forEach(e => console.log(`  ${e}`));
  console.log('='.repeat(70));

  ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
