// Test image generation via direct HTTP (bypass CORS) + check ImageFX page
const WebSocket = require('ws');
const https = require('https');

const CDP_URL = 'http://127.0.0.1:9222';
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

async function getFlowPage() {
  const resp = await fetch(`${CDP_URL}/json`);
  const pages = await resp.json();
  return pages.find(p => p.url.includes('labs.google/fx'));
}

async function connectCDP(page) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 1;
    const pending = new Map();
    ws.on('open', () => {
      const cdp = {
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const msgId = id++;
            pending.set(msgId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        close() { ws.close(); }
      };
      resolve(cdp);
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
    ws.on('error', reject);
  });
}

async function evaluate(cdp, expr) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'eval error');
  return result.result.value;
}

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const page = await getFlowPage();
  if (!page) { log('ERROR: No Flow page found'); return; }
  const cdp = await connectCDP(page);

  try {
    // Get token
    const tokenData = await evaluate(cdp, `
      (() => {
        const s = window.__NEXT_DATA__?.props?.pageProps?.session;
        return s ? JSON.stringify({ token: s.access_token }) : '{}';
      })()
    `);
    const { token } = JSON.parse(tokenData);
    log(`Token OK`);

    const projectId = await evaluate(cdp, `
      (() => { const m = window.location.href.match(/project\\/([^\\/?]+)/); return m ? m[1] : ''; })()
    `);

    // Get recaptcha
    const getRecaptcha = async () => {
      try {
        return await evaluate(cdp, `
          window.grecaptcha.enterprise.execute('6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV', { action: 'generate' })
        `);
      } catch(e) { return ''; }
    };

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/plain;charset=UTF-8',
      'Origin': 'https://labs.google',
      'Referer': 'https://labs.google/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    // Test 1: image:batchAsyncGenerateImageText (same pattern as video)
    log('\n=== TEST 1: POST /v1/image:batchAsyncGenerateImageText ===');
    const rc1 = await getRecaptcha();
    const body1 = JSON.stringify({
      mediaGenerationContext: { batchId: require('crypto').randomUUID() },
      clientContext: {
        projectId: projectId,
        tool: 'PINHOLE',
        userPaygateTier: 'PAYGATE_TIER_TWO',
        sessionId: `;${Date.now()}`,
        recaptchaContext: { token: rc1, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
      },
      requests: [{
        textInput: { structuredPrompt: { parts: [{ text: 'a beautiful sunset over mountains' }] } },
        imageModelKey: 'imagen_3',
        metadata: {}
      }],
      useV2ModelConfig: true
    });
    let r = await httpPost('https://aisandbox-pa.googleapis.com/v1/image:batchAsyncGenerateImageText', headers, body1);
    log(`Status: ${r.status}`);
    log(`Body: ${r.body.substring(0, 500)}`);

    // Test 2: Same but with tool=IMAGEFX
    log('\n=== TEST 2: POST /v1/image:batchAsyncGenerateImageText (tool=IMAGEFX) ===');
    const rc2 = await getRecaptcha();
    const body2 = JSON.stringify({
      mediaGenerationContext: { batchId: require('crypto').randomUUID() },
      clientContext: {
        projectId: projectId,
        tool: 'IMAGEFX',
        userPaygateTier: 'PAYGATE_TIER_TWO',
        sessionId: `;${Date.now()}`,
        recaptchaContext: { token: rc2, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
      },
      requests: [{
        textInput: { structuredPrompt: { parts: [{ text: 'a cute cat sitting on a windowsill' }] } },
        imageModelKey: 'imagen_3',
        metadata: {}
      }],
      useV2ModelConfig: true
    });
    r = await httpPost('https://aisandbox-pa.googleapis.com/v1/image:batchAsyncGenerateImageText', headers, body2);
    log(`Status: ${r.status}`);
    log(`Body: ${r.body.substring(0, 500)}`);

    // Test 3: Different image model keys
    log('\n=== TEST 3: Test various image model keys ===');
    const imageModels = [
      'imagen_3', 'imagen_3_fast', 'imagen_3_landscape',
      'nano_banana_2', 'imagen_4', 'imagen_3_quality',
      'whisk_imagen3', 'imagen_3_ultra'
    ];

    for (const model of imageModels) {
      const rc = await getRecaptcha();
      const body = JSON.stringify({
        mediaGenerationContext: { batchId: require('crypto').randomUUID() },
        clientContext: {
          projectId: projectId,
          tool: 'PINHOLE',
          userPaygateTier: 'PAYGATE_TIER_TWO',
          sessionId: `;${Date.now()}`,
          recaptchaContext: { token: rc, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
        },
        requests: [{
          textInput: { structuredPrompt: { parts: [{ text: 'test image model ' + model }] } },
          imageModelKey: model,
          metadata: {}
        }],
        useV2ModelConfig: true
      });
      r = await httpPost('https://aisandbox-pa.googleapis.com/v1/image:batchAsyncGenerateImageText', headers, body);
      const icon = r.status === 200 ? '✓' : '✗';
      log(`  ${icon} ${model}: ${r.status} — ${r.body.substring(0, 150)}`);
      await sleep(1500);
    }

    // Test 4: Navigate to ImageFX and capture its API calls
    log('\n=== TEST 4: Navigate to ImageFX page and inspect ===');

    // Open ImageFX in the same tab to see what API it uses
    const imageFxUrl = 'https://labs.google/fx/tools/image-fx';

    // First, let's check what the ImageFX page source reveals
    const imageFxSource = await evaluate(cdp, `
      fetch('${imageFxUrl}').then(r => r.text()).then(html => {
        // Extract API endpoints from the page source
        const apiMatches = html.match(/aisandbox[^"'\`\\s]+/g) || [];
        const endpointMatches = html.match(/\\/v1\\/[^"'\`\\s]+/g) || [];
        const modelMatches = html.match(/imagen[^"'\`\\s]*/gi) || [];
        return JSON.stringify({
          apis: [...new Set(apiMatches)].slice(0, 20),
          endpoints: [...new Set(endpointMatches)].slice(0, 20),
          models: [...new Set(modelMatches)].slice(0, 20),
          length: html.length
        });
      })
    `);
    log(`ImageFX source analysis: ${imageFxSource}`);

    // Test 5: Check if there's a different base URL for images
    log('\n=== TEST 5: Try alternative base URLs ===');
    const altUrls = [
      'https://aisandbox-pa.googleapis.com/image:generate',
      'https://aisandbox-pa.googleapis.com/v1beta/image:generate',
      'https://aisandbox-pa.googleapis.com/v2/image:batchAsyncGenerateImageText',
    ];
    for (const url of altUrls) {
      const rc = await getRecaptcha();
      const body = JSON.stringify({
        mediaGenerationContext: { batchId: require('crypto').randomUUID() },
        clientContext: {
          projectId: projectId,
          tool: 'PINHOLE',
          userPaygateTier: 'PAYGATE_TIER_TWO',
          sessionId: `;${Date.now()}`,
          recaptchaContext: { token: rc, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
        },
        requests: [{
          textInput: { structuredPrompt: { parts: [{ text: 'test alt url' }] } },
          imageModelKey: 'imagen_3',
          metadata: {}
        }],
        useV2ModelConfig: true
      });
      r = await httpPost(url, headers, body);
      log(`  ${url}: ${r.status} — ${r.body.substring(0, 150)}`);
      await sleep(1000);
    }

  } finally {
    cdp.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
