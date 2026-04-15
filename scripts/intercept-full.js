/**
 * Full API intercept: navigate to project, capture all API traffic during generation.
 * Saves cookies, headers, endpoints, payloads to api-capture.json
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const CDP_PORT = 9222;

function send(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 99999);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
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
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });

  const target = pages.find(p => p.url.includes('labs.google') && p.type === 'page');
  if (!target) { console.error('No labs.google page'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  log('Connected');

  // Navigate to project or create new one
  let url = await evalJS(ws, 'window.location.href');
  log(`URL: ${url}`);

  // Check if we need to open/create a project
  const hasEditor = await evalJS(ws, `!!document.querySelector("div[contenteditable='true']")`);
  if (!hasEditor) {
    log('No editor - clicking New project...');
    const newProjBtn = await evalJS(ws, `(function(){
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].textContent.indexOf('New project') > -1) {
          var r = btns[i].getBoundingClientRect();
          return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
        }
      }
      // Try project links
      var links = document.querySelectorAll('a');
      for (var i = 0; i < links.length; i++) {
        if (links[i].href && links[i].href.indexOf('flow/project/') > -1 && links[i].href.indexOf('/edit/') === -1) {
          var r = links[i].getBoundingClientRect();
          if (r.width > 0) return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), href: links[i].href});
        }
      }
      return null;
    })()`);

    if (newProjBtn) {
      const btn = JSON.parse(newProjBtn);
      if (btn.href) {
        log(`Navigating to project: ${btn.href}`);
        await send(ws, 'Page.navigate', { url: btn.href });
      } else {
        log(`Clicking New project at (${btn.x}, ${btn.y})`);
        await cdpClick(ws, btn.x, btn.y);
      }
      await sleep(5000);
    }

    // Wait for editor
    for (let i = 0; i < 20; i++) {
      const ready = await evalJS(ws, `!!document.querySelector("div[contenteditable='true']")`);
      if (ready) break;
      if (i === 19) { log('Editor not found'); ws.close(); process.exit(1); }
      await sleep(2000);
    }
  }

  url = await evalJS(ws, 'window.location.href');
  log(`Project ready: ${url}`);

  // === CAPTURE COOKIES ===
  log('\n=== COOKIES ===');
  const cookies = await send(ws, 'Network.getCookies', { urls: ['https://labs.google', 'https://labs.google/fx', 'https://accounts.google.com'] });
  const cookieList = cookies.cookies || [];
  log(`Total: ${cookieList.length}`);

  const cookieString = cookieList.map(c => `${c.name}=${c.value}`).join('; ');

  // === CAPTURE SAPISIDHASH ===
  // Google APIs use SAPISIDHASH for auth
  const sapisid = cookieList.find(c => c.name === 'SAPISID');
  let sapisidHash = '';
  if (sapisid) {
    // SAPISIDHASH = SHA1(timestamp + " " + SAPISID + " " + origin)
    log(`SAPISID found: ${sapisid.value.substring(0, 20)}...`);
    sapisidHash = await evalJS(ws, `(async function(){
      var ts = Math.floor(Date.now()/1000);
      var sapisid = "${sapisid.value}";
      var origin = "https://labs.google";
      var input = ts + " " + sapisid + " " + origin;
      var encoder = new TextEncoder();
      var data = encoder.encode(input);
      var hash = await crypto.subtle.digest('SHA-1', data);
      var hex = Array.from(new Uint8Array(hash)).map(function(b){return b.toString(16).padStart(2,'0')}).join('');
      return ts + "_" + hex;
    })()`);
    log(`SAPISIDHASH: ${sapisidHash}`);
  }

  // === EXTRACT PAGE TOKENS ===
  log('\n=== PAGE TOKENS ===');
  const tokens = await evalJS(ws, `(function(){
    var result = {};
    // Check for __NEXT_DATA__ or similar
    if (window.__NEXT_DATA__) result.nextData = JSON.stringify(window.__NEXT_DATA__).substring(0, 500);
    // Check meta tags
    var metas = {};
    document.querySelectorAll('meta').forEach(function(m) {
      var key = m.name || m.httpEquiv || m.getAttribute('property');
      if (key) metas[key] = (m.content || '').substring(0, 100);
    });
    result.metas = metas;
    // Check for any global config
    var scriptTexts = Array.from(document.querySelectorAll('script')).map(function(s){ return s.textContent; }).join('\\n');
    var tokenMatch = scriptTexts.match(/"(?:token|apiKey|api_key|x-goog-api-key)"\\s*:\\s*"([^"]+)"/);
    if (tokenMatch) result.apiKey = tokenMatch[1];
    return JSON.stringify(result);
  })()`);
  log(`Tokens: ${tokens}`);

  // === ENABLE NETWORK CAPTURE ===
  log('\n=== ENABLING NETWORK CAPTURE ===');
  await send(ws, 'Network.enable');

  // Also enable Fetch to intercept requests
  await send(ws, 'Fetch.enable', {
    patterns: [
      { urlPattern: '*labs.google*api*', requestStage: 'Request' },
      { urlPattern: '*labs.google*trpc*', requestStage: 'Request' },
      { urlPattern: '*alkali*', requestStage: 'Request' },
      { urlPattern: '*generativelanguage*', requestStage: 'Request' }
    ]
  }).catch(() => log('Fetch.enable not available, using Network only'));

  const captured = [];
  const responseMap = {};

  // Handle Fetch.requestPaused - continue but log
  ws.on('message', (rawMsg) => {
    try {
      const data = JSON.parse(rawMsg);

      if (data.method === 'Fetch.requestPaused') {
        const req = data.params;
        log(`[FETCH] ${req.request.method} ${req.request.url.substring(0, 130)}`);
        log(`  Headers: ${JSON.stringify(req.request.headers).substring(0, 500)}`);
        if (req.request.postData) log(`  Body: ${req.request.postData.substring(0, 500)}`);
        // Continue the request
        send(ws, 'Fetch.continueRequest', { requestId: req.requestId }).catch(() => {});
      }

      if (data.method === 'Network.requestWillBeSent') {
        const req = data.params;
        const u = req.request.url;
        if (u.includes('labs.google') || u.includes('alkali') || u.includes('generativelanguage')) {
          const entry = {
            id: req.requestId,
            method: req.request.method,
            url: u,
            headers: req.request.headers,
            postData: req.request.postData || null,
            ts: Date.now()
          };
          captured.push(entry);

          // Log API calls only
          if (u.includes('/api/') || u.includes('trpc') || u.includes('generate') ||
              u.includes('media') || u.includes('alkali') || u.includes('generativelanguage') ||
              req.request.method === 'POST') {
            log(`>>> ${entry.method} ${u.length > 140 ? u.substring(0, 140) + '...' : u}`);
            if (entry.postData) {
              try {
                log(`    BODY: ${JSON.stringify(JSON.parse(entry.postData)).substring(0, 600)}`);
              } catch {
                log(`    BODY: ${entry.postData.substring(0, 400)}`);
              }
            }
          }
        }
      }

      if (data.method === 'Network.responseReceived') {
        const resp = data.params;
        const u = resp.response.url;
        if ((u.includes('labs.google') && (u.includes('/api/') || u.includes('trpc'))) ||
            u.includes('alkali') || u.includes('generativelanguage')) {
          responseMap[resp.requestId] = {
            status: resp.response.status,
            statusText: resp.response.statusText,
            headers: resp.response.headers,
            mimeType: resp.response.mimeType
          };
          log(`<<< ${resp.response.status} ${u.length > 140 ? u.substring(0, 140) + '...' : u}`);
        }
      }
    } catch (e) { /* ignore */ }
  });

  await sleep(2000);

  // === SUBMIT PROMPT ===
  log('\n=== SUBMITTING PROMPT ===');
  const initialCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  log(`Initial media: ${initialCount}`);

  // Focus editor
  const editorPos = await evalJS(ws, `(function(){
    var ce = document.querySelector("div[contenteditable='true']");
    if (!ce) return null;
    var r = ce.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + 10), y: Math.round(r.top + r.height/2) });
  })()`);

  if (!editorPos) { log('No editor!'); ws.close(); return; }
  const ep = JSON.parse(editorPos);
  await cdpClick(ws, ep.x, ep.y);
  await sleep(500);

  // Type prompt
  await send(ws, 'Input.insertText', { text: 'A tiny fox exploring a magical forest, cinematic 4K' });
  await sleep(1000);

  // Click Create
  const createPos = await evalJS(ws, `(function(){
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var t = btns[i].textContent || '';
      if (t.indexOf('arrow_forward') > -1 && t.indexOf('Create') > -1 && btns[i].getBoundingClientRect().width > 0 && btns[i].getBoundingClientRect().y > 680) {
        var r = btns[i].getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
      }
    }
    return null;
  })()`);

  if (!createPos) { log('No Create button!'); ws.close(); return; }
  const cp = JSON.parse(createPos);
  log(`Clicking Create at (${cp.x}, ${cp.y})`);
  await cdpClick(ws, cp.x, cp.y);

  // === WAIT FOR GENERATION ===
  log('\n=== WAITING FOR GENERATION ===');
  const startTime = Date.now();
  const maxWait = 5 * 60 * 1000;

  while (Date.now() - startTime < maxWait) {
    await sleep(5000);
    const count = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`[${elapsed}s] media=${count}/${initialCount} api_calls=${captured.length}`);

    if (count > initialCount) {
      log('Generation complete!');
      await sleep(5000);
      break;
    }
  }

  // === GET RESPONSE BODIES ===
  log('\n=== FETCHING RESPONSE BODIES ===');
  const apiRequests = captured.filter(r =>
    r.url.includes('/api/') || r.url.includes('trpc') || r.postData ||
    r.url.includes('alkali') || r.url.includes('generativelanguage')
  );

  for (const req of apiRequests) {
    try {
      const body = await send(ws, 'Network.getResponseBody', { requestId: req.id });
      req.responseBody = body.body;
      req.responseBase64 = body.base64Encoded;
      if (req.responseBody && !body.base64Encoded) {
        log(`RESP ${req.url.substring(0, 100)}: ${req.responseBody.substring(0, 400)}`);
      }
    } catch (e) { /* not available */ }
  }

  // === SAVE REPORT ===
  const report = {
    timestamp: new Date().toISOString(),
    pageUrl: url,
    cookies: {
      total: cookieList.length,
      auth: cookieList.filter(c =>
        c.name.includes('SID') || c.name.startsWith('__Secure') || c.name === 'APISID' ||
        c.name === 'SAPISID' || c.name === 'HSID' || c.name === 'SSID' || c.name === 'NID'
      ).map(c => ({ name: c.name, domain: c.domain, value: c.value })),
      all: cookieList.map(c => ({ name: c.name, domain: c.domain, value: c.value, httpOnly: c.httpOnly, secure: c.secure })),
      fullString: cookieString
    },
    sapisidHash,
    pageTokens: JSON.parse(tokens),
    requests: apiRequests.map(r => ({
      method: r.method,
      url: r.url,
      headers: r.headers,
      postData: r.postData,
      response: responseMap[r.id] || null,
      responseBody: r.responseBody ? r.responseBody.substring(0, 20000) : null,
      responseBase64: r.responseBase64 || false
    })),
    allUrls: captured.map(r => `${r.method} ${r.url}`),
    summary: {
      totalCaptured: captured.length,
      apiCalls: apiRequests.length,
      endpoints: [...new Set(apiRequests.map(r => {
        try { const u = new URL(r.url); return `${r.method} ${u.pathname}`; }
        catch { return r.url.substring(0, 100); }
      }))]
    }
  };

  const reportPath = 'c:/Users/Admin/Desktop/veo3/scripts/api-capture.json';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`\nSaved to ${reportPath}`);

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('API CAPTURE SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total captured: ${captured.length}`);
  console.log(`API calls: ${apiRequests.length}`);
  console.log(`\nEndpoints:`);
  report.summary.endpoints.forEach(e => console.log(`  ${e}`));
  console.log('\nPOST requests:');
  apiRequests.filter(r => r.postData).forEach(r => {
    console.log(`\n  ${r.method} ${r.url.substring(0, 140)}`);
    console.log(`  BODY: ${r.postData.substring(0, 600)}`);
    if (r.responseBody) console.log(`  RESP: ${r.responseBody.substring(0, 400)}`);
  });
  console.log(`\nSAPISIDHASH: ${sapisidHash}`);
  console.log(`Auth cookies: ${report.cookies.auth.length}`);
  console.log('='.repeat(70));

  ws.close();
  log('Done');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
