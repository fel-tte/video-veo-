/**
 * Wait for user to log in, then intercept API requests during video generation.
 * Usage: node scripts/wait-login-and-intercept.js
 *
 * 1. Opens Chrome to Flow page
 * 2. Waits for user to log in manually
 * 3. Navigates to a project
 * 4. Captures all API traffic during a generation
 * 5. Saves full report with cookies, endpoints, headers, payloads
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const CDP_PORT = 9222;

async function getPages() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function send(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 99999);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
    function h(m) {
      const d = JSON.parse(m);
      if (d.id === id) { clearTimeout(t); ws.removeListener('message', h); resolve(d.result); }
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

async function main() {
  // Connect to Chrome
  const pages = await getPages();
  const target = pages.find(p => p.url.includes('labs.google') && p.type === 'page');
  if (!target) { console.error('No labs.google page found. Open Chrome with --remote-debugging-port=9222'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  log('Connected to Chrome');

  // Check if already on a project page
  let url = await evalJS(ws, 'window.location.href');
  log(`Current URL: ${url}`);

  // === PHASE 1: Wait for login ===
  log('\n=== WAITING FOR LOGIN ===');
  log('Please log in to labs.google in the Chrome browser...');
  log('Looking for sign-in button or authenticated state...');

  let loggedIn = false;
  for (let i = 0; i < 120; i++) { // 4 minutes max
    // Check for editor (authenticated project page) or project links
    const state = await evalJS(ws, `(function(){
      var editor = document.querySelector("div[contenteditable='true']");
      var signInBtn = document.querySelector('[data-test-id="sign-in-button"], a[href*="accounts.google"]');
      var projectLinks = Array.from(document.querySelectorAll('a')).filter(function(a){ return a.href && a.href.indexOf('flow/project/') > -1; }).map(function(a){ return a.href; });
      var createBtn = document.querySelector('a[href*="flow/project/new"], button[data-test-id="create-project"]');
      return JSON.stringify({
        hasEditor: !!editor,
        hasSignIn: !!signInBtn,
        projectLinks: projectLinks.slice(0, 5),
        hasCreateBtn: !!createBtn,
        url: window.location.href,
        bodySnippet: document.body ? document.body.innerText.substring(0, 200) : ''
      });
    })()`);

    const s = JSON.parse(state);

    if (s.hasEditor) {
      log('Editor found - already on a project page!');
      loggedIn = true;
      break;
    }

    if (s.projectLinks.length > 0) {
      log('Project links found - logged in!');
      log(`Navigating to: ${s.projectLinks[0]}`);
      await send(ws, 'Page.navigate', { url: s.projectLinks[0] });
      await sleep(5000);
      loggedIn = true;
      break;
    }

    // Check if the page has changed (user might have navigated)
    if (s.url !== url) {
      url = s.url;
      log(`Page changed to: ${url}`);
    }

    // Check body text for signs of being logged in
    if (s.bodySnippet.includes('New project') || s.bodySnippet.includes('Your projects') || s.bodySnippet.includes('Create')) {
      log('Appears logged in (found project UI text)');
      // Try to find and click on a project or create new
      loggedIn = true;
      break;
    }

    if (i % 10 === 0) {
      log(`Still waiting... (${i * 2}s) URL: ${s.url}`);
      if (s.hasSignIn) log('  Sign-in button visible - please click it');
    }
    await sleep(2000);
  }

  if (!loggedIn) {
    log('TIMEOUT waiting for login. Please log in and re-run.');
    ws.close();
    process.exit(1);
  }

  // === PHASE 2: Navigate to project page with editor ===
  url = await evalJS(ws, 'window.location.href');
  log(`\n=== NAVIGATING TO PROJECT ===`);
  log(`Current: ${url}`);

  // If not on a project page, try to find one
  if (!url.includes('flow/project/') || url.includes('/edit/')) {
    // Try navigating to flow to get project list
    if (!url.includes('flow/project/')) {
      // Look for any project link on current page
      const projectUrl = await evalJS(ws, `(function(){
        var links = document.querySelectorAll('a');
        for (var i = 0; i < links.length; i++) {
          if (links[i].href && links[i].href.indexOf('flow/project/') > -1 && links[i].href.indexOf('/edit/') === -1) {
            return links[i].href;
          }
        }
        return '';
      })()`);

      if (projectUrl) {
        log(`Found project: ${projectUrl}`);
        await send(ws, 'Page.navigate', { url: projectUrl });
        await sleep(5000);
      }
    }

    if (url.includes('/edit/')) {
      const projectBase = url.split('/edit/')[0];
      log(`On edit page, going to project: ${projectBase}`);
      await send(ws, 'Page.navigate', { url: projectBase });
      await sleep(5000);
    }
  }

  // Wait for editor to appear
  log('Waiting for editor...');
  for (let i = 0; i < 30; i++) {
    const hasEditor = await evalJS(ws, `!!document.querySelector("div[contenteditable='true']")`);
    if (hasEditor) { log('Editor ready!'); break; }
    if (i === 29) { log('Editor not found after 60s'); ws.close(); process.exit(1); }
    await sleep(2000);
  }

  url = await evalJS(ws, 'window.location.href');
  log(`Ready at: ${url}`);

  // === PHASE 3: Capture cookies ===
  log('\n=== CAPTURING COOKIES ===');
  const cookies = await send(ws, 'Network.getCookies', { urls: ['https://labs.google', 'https://labs.google/fx'] });
  const cookieList = cookies.cookies || [];
  log(`Total cookies: ${cookieList.length}`);

  const authCookies = cookieList.filter(c =>
    c.name.includes('SID') || c.name.includes('PSID') || c.name.startsWith('__Secure') ||
    c.name === 'NID' || c.name === 'SIDCC' || c.name === 'APISID' || c.name === 'SAPISID' ||
    c.name === 'HSID' || c.name === 'SSID'
  );
  log(`Auth cookies: ${authCookies.length}`);
  authCookies.forEach(c => log(`  ${c.name} (${c.domain}) = ${c.value.substring(0, 20)}...`));

  const cookieString = cookieList.map(c => `${c.name}=${c.value}`).join('; ');

  // === PHASE 4: Get page headers/tokens ===
  log('\n=== EXTRACTING PAGE TOKENS ===');
  const pageTokens = await evalJS(ws, `(function(){
    var meta = {};
    document.querySelectorAll('meta').forEach(function(m) {
      if (m.name || m.httpEquiv || m.getAttribute('property')) {
        var key = m.name || m.httpEquiv || m.getAttribute('property');
        meta[key] = (m.content || '').substring(0, 100);
      }
    });
    // Look for any embedded config/token in scripts
    var scripts = document.querySelectorAll('script');
    var configData = '';
    for (var i = 0; i < scripts.length; i++) {
      var text = scripts[i].textContent || '';
      if (text.indexOf('token') > -1 || text.indexOf('apiKey') > -1 || text.indexOf('config') > -1) {
        // Extract relevant parts
        var matches = text.match(/["'](?:token|apiKey|api_key|authorization|x-goog)[^"']*["']\s*[:=]\s*["']([^"']+)["']/gi);
        if (matches) configData += matches.join('; ');
      }
    }
    return JSON.stringify({ meta: meta, configTokens: configData.substring(0, 1000) });
  })()`);
  log('Page tokens: ' + pageTokens);

  // === PHASE 5: Enable network capture ===
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
        // Capture ALL labs.google requests (not just API)
        if (u.includes('labs.google') || u.includes('alkalicore') || u.includes('generativelanguage')) {
          const entry = {
            id: req.requestId,
            method: req.request.method,
            url: u,
            headers: req.request.headers,
            postData: req.request.postData || null,
            ts: Date.now()
          };
          captured.push(entry);

          // Only log interesting ones
          if (u.includes('/api/') || u.includes('trpc') || u.includes('generate') ||
              u.includes('media') || u.includes('alkali') || !u.includes('.js') && !u.includes('.css')) {
            log(`>>> ${entry.method} ${u.length > 130 ? u.substring(0, 130) + '...' : u}`);
            if (entry.postData) {
              try {
                const parsed = JSON.parse(entry.postData);
                log(`    BODY: ${JSON.stringify(parsed).substring(0, 500)}`);
              } catch {
                log(`    BODY: ${entry.postData.substring(0, 300)}`);
              }
            }
          }
        }
      }

      if (data.method === 'Network.responseReceived') {
        const resp = data.params;
        const u = resp.response.url;
        if (u.includes('labs.google') && (u.includes('/api/') || u.includes('trpc'))) {
          responseMap[resp.requestId] = {
            status: resp.response.status,
            statusText: resp.response.statusText,
            headers: resp.response.headers,
            mimeType: resp.response.mimeType
          };
          log(`<<< ${resp.response.status} ${u.length > 130 ? u.substring(0, 130) + '...' : u}`);
        }
      }
    } catch (e) { /* ignore parse errors from non-JSON messages */ }
  });

  // Let network listener settle
  await sleep(2000);

  // === PHASE 6: Submit prompt and capture traffic ===
  log('\n=== SUBMITTING PROMPT ===');
  const initialCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  log(`Initial media count: ${initialCount}`);

  // Focus editor
  const editorPos = await evalJS(ws, `(function(){
    var ce = document.querySelector("div[contenteditable='true']");
    if (!ce) return null;
    var r = ce.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + 10), y: Math.round(r.top + r.height/2) });
  })()`);

  if (!editorPos) { log('No editor found!'); ws.close(); return; }
  const ep = JSON.parse(editorPos);

  // CDP click to focus
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: ep.x, y: ep.y, button: 'none' });
  await sleep(100);
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: ep.x, y: ep.y, button: 'left', clickCount: 1 });
  await sleep(50);
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: ep.x, y: ep.y, button: 'left', clickCount: 1 });
  await sleep(500);

  // Insert text via CDP (Slate.js compatible)
  await send(ws, 'Input.insertText', { text: 'A tiny fox exploring a magical forest, cinematic 4K' });
  await sleep(1000);

  // Click Create button
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

  if (!createPos) { log('No Create button found!'); ws.close(); return; }
  const cp = JSON.parse(createPos);
  log(`Clicking Create at (${cp.x}, ${cp.y})`);

  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cp.x, y: cp.y, button: 'none' });
  await sleep(100);
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cp.x, y: cp.y, button: 'left', clickCount: 1 });
  await sleep(50);
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cp.x, y: cp.y, button: 'left', clickCount: 1 });

  // === PHASE 7: Wait for generation ===
  log('\n=== WAITING FOR GENERATION (capturing all API traffic) ===');
  const startTime = Date.now();
  const maxWait = 5 * 60 * 1000; // 5 minutes

  while (Date.now() - startTime < maxWait) {
    await sleep(5000);
    const count = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`[${elapsed}s] media=${count}/${initialCount} captured=${captured.length} API calls`);

    if (count > initialCount) {
      log('Generation complete!');
      await sleep(5000); // Capture remaining traffic
      break;
    }
  }

  // === PHASE 8: Get response bodies ===
  log('\n=== FETCHING RESPONSE BODIES ===');
  for (const req of captured) {
    if (!req.url.includes('/api/') && !req.url.includes('trpc')) continue;
    try {
      const body = await send(ws, 'Network.getResponseBody', { requestId: req.id });
      req.responseBody = body.body;
      req.responseBase64 = body.base64Encoded;
      if (req.responseBody && !body.base64Encoded) {
        log(`RESP ${req.url.substring(0, 100)}: ${req.responseBody.substring(0, 300)}`);
      }
    } catch (e) {
      // Response may not be available
    }
  }

  // === SAVE REPORT ===
  const apiRequests = captured.filter(r => r.url.includes('/api/') || r.url.includes('trpc') || r.postData);

  const report = {
    timestamp: new Date().toISOString(),
    pageUrl: url,
    cookies: {
      total: cookieList.length,
      auth: authCookies.map(c => ({ name: c.name, domain: c.domain, value: c.value })),
      all: cookieList.map(c => ({ name: c.name, domain: c.domain, value: c.value, httpOnly: c.httpOnly, secure: c.secure })),
      fullString: cookieString
    },
    pageTokens: JSON.parse(pageTokens),
    requests: apiRequests.map(r => ({
      method: r.method,
      url: r.url,
      headers: r.headers,
      postData: r.postData,
      response: responseMap[r.id] || null,
      responseBody: r.responseBody ? r.responseBody.substring(0, 10000) : null,
      responseBase64: r.responseBase64 || false
    })),
    allRequestUrls: captured.map(r => `${r.method} ${r.url}`),
    summary: {
      totalCaptured: captured.length,
      apiCalls: apiRequests.length,
      endpoints: [...new Set(apiRequests.map(r => {
        try {
          const u = new URL(r.url);
          return `${r.method} ${u.pathname}`;
        } catch { return r.url.substring(0, 100); }
      }))]
    }
  };

  const reportPath = 'c:/Users/Admin/Desktop/veo3/scripts/api-capture.json';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`\nSaved full report to ${reportPath}`);

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('API CAPTURE REPORT');
  console.log('='.repeat(70));
  console.log(`\nTotal requests captured: ${captured.length}`);
  console.log(`API requests: ${apiRequests.length}`);
  console.log(`\nAuth cookies (${authCookies.length}):`);
  authCookies.forEach(c => console.log(`  ${c.name} (${c.domain})`));
  console.log(`\nAPI Endpoints discovered:`);
  report.summary.endpoints.forEach(e => console.log(`  ${e}`));
  console.log('\nRequests with POST data:');
  apiRequests.filter(r => r.postData).forEach(r => {
    console.log(`\n  ${r.method} ${r.url.substring(0, 130)}`);
    console.log(`  POST: ${r.postData.substring(0, 500)}`);
  });
  console.log('\nKey response data:');
  apiRequests.filter(r => r.responseBody && !r.responseBase64).forEach(r => {
    console.log(`\n  ${r.method} ${r.url.substring(0, 130)}`);
    console.log(`  RESP: ${r.responseBody.substring(0, 500)}`);
  });
  console.log('='.repeat(70));

  ws.close();
  log('Done');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
