/**
 * Intercept ALL network requests during a video generation to discover the API.
 * This will capture: endpoints, cookies, headers, payloads, responses.
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
  let flowPage = pages.find(p => p.url.includes('flow/project') && !p.url.includes('/edit/'));
  if (!flowPage) flowPage = pages.find(p => p.url.includes('flow/project'));
  if (!flowPage) { console.error('No Flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  let url = await evalJS(ws, 'window.location.href');

  if (url.includes('/edit/')) {
    await sendCDP(ws, 'Page.navigate', { url: url.split('/edit/')[0] });
    await sleep(5000);
  }
  try { await sendCDP(ws, 'Page.bringToFront'); } catch(e) {}
  await sleep(1000);

  // ===== Step 1: Get ALL cookies =====
  log('=== Getting cookies ===');
  const cookies = await sendCDP(ws, 'Network.getCookies', { urls: ['https://labs.google'] });
  const cookieList = cookies.cookies || [];
  log(`Found ${cookieList.length} cookies`);

  // Save cookies
  const cookieData = cookieList.map(c => ({
    name: c.name,
    value: c.value.substring(0, 50) + (c.value.length > 50 ? '...' : ''),
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite
  }));
  log('Key cookies:');
  cookieList.forEach(c => {
    if (['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'NID', 'SIDCC'].includes(c.name) || c.name.startsWith('__Secure')) {
      log(`  ${c.name} = ${c.value.substring(0, 30)}... (domain: ${c.domain})`);
    }
  });

  // ===== Step 2: Enable Network interception =====
  log('\n=== Enabling network interception ===');
  await sendCDP(ws, 'Network.enable');

  const capturedRequests = [];
  const capturedResponses = {};

  // Listen for requests
  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.method === 'Network.requestWillBeSent') {
      const req = data.params;
      const reqUrl = req.request.url;

      // Only capture labs.google API requests (not static assets)
      if (reqUrl.includes('labs.google/fx/api') ||
          reqUrl.includes('labs.google/fx/tools') ||
          reqUrl.includes('trpc') ||
          reqUrl.includes('generateVideo') ||
          reqUrl.includes('generateImage') ||
          reqUrl.includes('createMedia') ||
          reqUrl.includes('getMedia') ||
          reqUrl.includes('generate')) {

        const entry = {
          requestId: req.requestId,
          url: reqUrl,
          method: req.request.method,
          headers: req.request.headers,
          postData: req.request.postData,
          timestamp: new Date().toISOString()
        };
        capturedRequests.push(entry);
        log(`>>> ${req.request.method} ${reqUrl.substring(0, 120)}`);
        if (req.request.postData) {
          log(`    BODY: ${req.request.postData.substring(0, 300)}`);
        }
      }
    }

    if (data.method === 'Network.responseReceived') {
      const resp = data.params;
      const reqUrl = resp.response.url;
      if (reqUrl.includes('labs.google/fx/api') || reqUrl.includes('trpc')) {
        capturedResponses[resp.requestId] = {
          status: resp.response.status,
          headers: resp.response.headers,
          url: reqUrl
        };
        log(`<<< ${resp.response.status} ${reqUrl.substring(0, 120)}`);
      }
    }
  });

  // ===== Step 3: Submit a prompt and capture everything =====
  log('\n=== Submitting prompt to capture API requests ===');
  const initialCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  log(`Initial media: ${initialCount}`);

  // Type prompt
  const editorPos = await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return null;
      const r = ce.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + 10), y: Math.round(r.top + r.height/2) });
    })()
  `);
  if (!editorPos) { console.error('No editor'); ws.close(); return; }

  const ep = JSON.parse(editorPos);
  await cdpClick(ws, ep.x, ep.y);
  await sleep(500);
  await sendCDP(ws, 'Input.insertText', { text: 'A small kitten playing with yarn, soft lighting' });
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

  if (!createPos) { console.error('No Create button'); ws.close(); return; }
  const cp = JSON.parse(createPos);
  log(`Clicking Create at (${cp.x}, ${cp.y})`);
  await cdpClick(ws, cp.x, cp.y);

  // Wait and capture network traffic
  log('\nWaiting for generation + capturing API calls (3 min max)...');
  const startTime = Date.now();

  while (Date.now() - startTime < 3 * 60 * 1000) {
    await sleep(5000);
    const count = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`[${elapsed}s] media=${count}/${initialCount}, captured=${capturedRequests.length} requests`);

    if (count > initialCount) {
      log('Generation complete!');
      // Wait a bit more to capture download-related requests
      await sleep(5000);
      break;
    }
  }

  // ===== Step 4: Try to get response bodies for key requests =====
  log('\n=== Getting response bodies ===');
  for (const req of capturedRequests) {
    try {
      const body = await sendCDP(ws, 'Network.getResponseBody', { requestId: req.requestId });
      req.responseBody = body.body?.substring(0, 2000);
      req.responseBase64 = body.base64Encoded;
      log(`Response for ${req.url.substring(0, 80)}: ${req.responseBody?.substring(0, 200)}`);
    } catch (e) {
      // Response may not be available
    }
  }

  // ===== Step 5: Also get cookies as header string =====
  const cookieHeader = cookieList.map(c => `${c.name}=${c.value}`).join('; ');

  // ===== Save results =====
  const report = {
    cookies: cookieData,
    cookieHeader: cookieHeader.substring(0, 500) + '...',
    fullCookieNames: cookieList.map(c => c.name),
    requests: capturedRequests,
    responses: capturedResponses,
    summary: {
      totalRequests: capturedRequests.length,
      endpoints: [...new Set(capturedRequests.map(r => {
        const u = new URL(r.url);
        return `${r.method} ${u.pathname}`;
      }))]
    }
  };

  fs.writeFileSync('c:/Users/Admin/Desktop/veo3/scripts/api-capture.json', JSON.stringify(report, null, 2));
  log('\nSaved to scripts/api-capture.json');

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('API CAPTURE SUMMARY');
  console.log('='.repeat(60));
  console.log(`\nCookies: ${cookieList.length} total`);
  console.log(`Requests captured: ${capturedRequests.length}`);
  console.log('\nEndpoints:');
  report.summary.endpoints.forEach(e => console.log(`  ${e}`));

  console.log('\nKey requests with bodies:');
  capturedRequests.forEach(r => {
    if (r.postData || r.responseBody) {
      console.log(`\n  ${r.method} ${r.url.substring(0, 120)}`);
      if (r.postData) console.log(`  POST: ${r.postData.substring(0, 300)}`);
      if (r.responseBody) console.log(`  RESP: ${r.responseBody.substring(0, 300)}`);
    }
  });
  console.log('='.repeat(60));

  ws.close();
  log('Done');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
