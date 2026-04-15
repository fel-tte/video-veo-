/**
 * Intercept API requests — works from any Flow page state.
 * Navigates to project if needed, captures all API traffic during generation.
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

async function sendCDP(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 100000);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
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

async function evalJS(ws, expression) {
  const { result } = await sendCDP(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  });
  if (result.subtype === 'error') throw new Error(result.description);
  return result.value;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function cdpClick(ws, x, y) {
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(100);
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(50);
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function main() {
  const pages = await getPages();
  // Find any labs.google page
  let target = pages.find(p => p.url.includes('labs.google'));
  if (!target) { console.error('No labs.google page found'); process.exit(1); }

  const ws = await connectToPage(target.webSocketDebuggerUrl);
  let url = await evalJS(ws, 'window.location.href');
  log(`Connected to: ${url}`);

  // Navigate to project page if needed
  if (!url.includes('flow/project') || url.includes('/edit/')) {
    if (url.includes('/edit/')) {
      await sendCDP(ws, 'Page.navigate', { url: url.split('/edit/')[0] });
    } else {
      // Go to flow main and find a project
      await sendCDP(ws, 'Page.navigate', { url: 'https://labs.google/fx/tools/flow' });
    }
    await sleep(5000);
    url = await evalJS(ws, 'window.location.href');
    log(`Now at: ${url}`);
  }

  // Wait for contenteditable (login check)
  log('Waiting for login/editor...');
  for (let i = 0; i < 30; i++) {
    const hasEditor = await evalJS(ws, `!!document.querySelector("div[contenteditable='true']")`);
    if (hasEditor) { log('Editor found — logged in'); break; }

    // Check if there's a project link to click
    const projectLink = await evalJS(ws, `
      (function(){
        const links = document.querySelectorAll('a[href*="flow/project"]');
        for (const a of links) {
          if (a.href && !a.href.includes('/edit/')) return a.href;
        }
        return '';
      })()
    `);
    if (projectLink) {
      log(`Found project link: ${projectLink}`);
      await sendCDP(ws, 'Page.navigate', { url: projectLink });
      await sleep(3000);
    }

    if (i === 29) {
      log('TIMEOUT waiting for editor. Please login manually in the browser.');
      log('After logging in, re-run this script.');
      ws.close();
      process.exit(1);
    }
    await sleep(2000);
  }

  url = await evalJS(ws, 'window.location.href');
  log(`Ready at: ${url}`);

  // ===== Get cookies =====
  log('\n=== COOKIES ===');
  const cookies = await sendCDP(ws, 'Network.getCookies', { urls: ['https://labs.google', 'https://labs.google/fx'] });
  const cookieList = cookies.cookies || [];
  log(`Total cookies: ${cookieList.length}`);

  // Important auth cookies
  const authCookies = cookieList.filter(c =>
    c.name.includes('SID') || c.name.includes('PSID') || c.name.startsWith('__Secure') ||
    c.name === 'NID' || c.name === 'SIDCC' || c.name === 'APISID' || c.name === 'SAPISID' ||
    c.name === 'HSID' || c.name === 'SSID'
  );
  log(`Auth cookies: ${authCookies.length}`);
  authCookies.forEach(c => log(`  ${c.name} (${c.domain}) = ${c.value.substring(0, 20)}...`));

  // Full cookie string for requests
  const cookieString = cookieList.map(c => `${c.name}=${c.value}`).join('; ');

  // ===== Enable Network + Fetch interception =====
  log('\n=== ENABLING NETWORK CAPTURE ===');
  await sendCDP(ws, 'Network.enable');

  const captured = [];
  const responseMap = {};

  ws.on('message', (rawMsg) => {
    const data = JSON.parse(rawMsg);

    if (data.method === 'Network.requestWillBeSent') {
      const req = data.params;
      const u = req.request.url;
      // Capture all labs.google API and trpc requests
      if ((u.includes('labs.google') && (u.includes('/api/') || u.includes('trpc'))) ||
          u.includes('alkalicore') || u.includes('generate') || u.includes('media')) {
        const entry = {
          id: req.requestId,
          method: req.request.method,
          url: u,
          headers: req.request.headers,
          postData: req.request.postData || null,
          ts: Date.now()
        };
        captured.push(entry);
        log(`>>> ${entry.method} ${u.length > 120 ? u.substring(0, 120) + '...' : u}`);
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
        log(`<<< ${resp.response.status} ${u.length > 120 ? u.substring(0, 120) + '...' : u}`);
      }
    }
  });

  // ===== Submit prompt =====
  await sleep(2000); // Let network listener settle
  log('\n=== SUBMITTING PROMPT ===');

  const initialCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  log(`Initial media: ${initialCount}`);

  // Focus + type prompt
  const editorPos = await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return null;
      const r = ce.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + 10), y: Math.round(r.top + r.height/2) });
    })()
  `);
  if (!editorPos) { log('No editor found'); ws.close(); return; }

  const ep = JSON.parse(editorPos);
  await cdpClick(ws, ep.x, ep.y);
  await sleep(500);
  await sendCDP(ws, 'Input.insertText', { text: 'A tiny fox exploring a magical forest, cinematic 4K' });
  await sleep(1000);

  // Click Create
  const createPos = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('arrow_forward') && t.includes('Create') && b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().y > 680) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
        }
      }
      return null;
    })()
  `);
  if (!createPos) { log('No Create button'); ws.close(); return; }

  const cp = JSON.parse(createPos);
  log(`Clicking Create at (${cp.x}, ${cp.y})`);
  await cdpClick(ws, cp.x, cp.y);

  // ===== Wait for generation + capture traffic =====
  log('\n=== WAITING FOR GENERATION (capturing API traffic) ===');
  const startTime = Date.now();
  const maxWait = 4 * 60 * 1000;

  while (Date.now() - startTime < maxWait) {
    await sleep(5000);
    const count = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`[${elapsed}s] media=${count}/${initialCount} captured=${captured.length} API calls`);

    if (count > initialCount) {
      log('Generation complete!');
      await sleep(3000); // Capture remaining calls
      break;
    }
  }

  // ===== Get response bodies =====
  log('\n=== FETCHING RESPONSE BODIES ===');
  for (const req of captured) {
    try {
      const body = await sendCDP(ws, 'Network.getResponseBody', { requestId: req.id });
      req.responseBody = body.body;
      req.responseBase64 = body.base64Encoded;
      if (req.responseBody && !body.base64Encoded) {
        log(`RESP ${req.url.substring(0, 80)}: ${req.responseBody.substring(0, 300)}`);
      }
    } catch (e) {
      // Some responses not available
    }
  }

  // ===== SAVE REPORT =====
  const report = {
    timestamp: new Date().toISOString(),
    cookies: {
      total: cookieList.length,
      auth: authCookies.map(c => ({ name: c.name, domain: c.domain, valuePreview: c.value.substring(0, 30) })),
      fullString: cookieString
    },
    requests: captured.map(r => ({
      method: r.method,
      url: r.url,
      headers: r.headers,
      postData: r.postData,
      response: responseMap[r.id] || null,
      responseBody: r.responseBody?.substring(0, 5000) || null
    })),
    summary: {
      totalApiCalls: captured.length,
      endpoints: [...new Set(captured.map(r => {
        try {
          const u = new URL(r.url);
          return `${r.method} ${u.pathname}${u.search ? '?' + u.searchParams.toString().substring(0, 60) : ''}`;
        } catch { return r.url.substring(0, 100); }
      }))]
    }
  };

  fs.writeFileSync('c:/Users/Admin/Desktop/veo3/scripts/api-capture.json', JSON.stringify(report, null, 2));
  log('\nSaved full report to scripts/api-capture.json');

  // ===== PRINT SUMMARY =====
  console.log('\n' + '='.repeat(70));
  console.log('API CAPTURE REPORT');
  console.log('='.repeat(70));
  console.log(`\nTotal API calls: ${captured.length}`);
  console.log('\nEndpoints discovered:');
  report.summary.endpoints.forEach(e => console.log(`  ${e}`));
  console.log('\nRequests with POST data:');
  captured.filter(r => r.postData).forEach(r => {
    console.log(`\n  ${r.method} ${r.url.substring(0, 120)}`);
    console.log(`  POST: ${r.postData.substring(0, 500)}`);
  });
  console.log('\nKey response data:');
  captured.filter(r => r.responseBody && !r.responseBase64).forEach(r => {
    console.log(`\n  ${r.method} ${r.url.substring(0, 120)}`);
    console.log(`  RESP: ${r.responseBody.substring(0, 500)}`);
  });
  console.log('='.repeat(70));

  ws.close();
  log('Done');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
