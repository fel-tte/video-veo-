/**
 * Test if we can programmatically get reCAPTCHA Enterprise tokens
 * from the browser and use them in HTTP requests.
 */
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

function send(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 99999);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
    function h(m) { const d = JSON.parse(m); if (d.id === id) { clearTimeout(t); ws.removeListener('message', h); if (d.error) reject(new Error(d.error.message)); else resolve(d.result); } }
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJS(ws, expr) {
  const { result } = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (result.subtype === 'error') throw new Error(result.description);
  return result.value;
}

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

async function main() {
  const pages = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });

  const target = pages.find(p => p.url.includes('labs.google') && p.type === 'page');
  if (!target) { console.error('No page'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  log('Connected');

  // 1. Get access token
  const tokenData = await evalJS(ws, `(function(){
    if (window.__NEXT_DATA__) {
      var s = window.__NEXT_DATA__.props.pageProps.session;
      return JSON.stringify({ access_token: s.access_token, expires: s.expires });
    }
    return '{}';
  })()`);
  const tokens = JSON.parse(tokenData);
  log(`Access token: ${tokens.access_token ? tokens.access_token.substring(0, 40) + '...' : 'MISSING'}`);

  // 2. Try to get reCAPTCHA token programmatically
  log('\n=== RECAPTCHA TOKEN ===');
  const recaptchaToken = await evalJS(ws, `(async function(){
    // The site key from the iframe URL
    var siteKey = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

    // Try grecaptcha.enterprise.execute
    if (window.grecaptcha && window.grecaptcha.enterprise) {
      try {
        var token = await window.grecaptcha.enterprise.execute(siteKey, { action: 'generate' });
        return JSON.stringify({ method: 'grecaptcha.enterprise.execute', token: token });
      } catch(e) {
        return JSON.stringify({ error: 'grecaptcha failed: ' + e.message });
      }
    }

    // Check if grecaptcha exists at all
    return JSON.stringify({
      hasGrecaptcha: !!window.grecaptcha,
      hasEnterprise: !!(window.grecaptcha && window.grecaptcha.enterprise),
      keys: window.grecaptcha ? Object.keys(window.grecaptcha) : []
    });
  })()`);
  log(`reCAPTCHA result: ${recaptchaToken}`);

  const rcResult = JSON.parse(recaptchaToken);

  if (rcResult.token) {
    log(`Got reCAPTCHA token! Length: ${rcResult.token.length}`);
    log(`Token preview: ${rcResult.token.substring(0, 80)}...`);

    // 3. Try making a direct HTTP request with this token
    log('\n=== TESTING DIRECT HTTP REQUEST ===');

    const projectId = await evalJS(ws, `window.location.pathname.split('/').filter(Boolean).pop()`);
    log(`Project ID: ${projectId}`);

    const body = JSON.stringify({
      mediaGenerationContext: { batchId: require('crypto').randomUUID() },
      clientContext: {
        projectId: projectId,
        tool: "PINHOLE",
        userPaygateTier: "PAYGATE_TIER_TWO",
        sessionId: ";" + Date.now(),
        recaptchaContext: {
          token: rcResult.token,
          applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB"
        }
      },
      requests: [{
        aspectRatio: "VIDEO_ASPECT_RATIO_LANDSCAPE",
        seed: Math.floor(Math.random() * 10000),
        textInput: {
          structuredPrompt: {
            parts: [{ text: "A gentle breeze through autumn leaves, slow motion" }]
          }
        },
        videoModelKey: "veo_3_1_t2v_fast_ultra",
        metadata: {}
      }],
      useV2ModelConfig: true
    });

    log(`Request body length: ${body.length}`);

    // Make the HTTP request
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'aisandbox-pa.googleapis.com',
        path: '/v1/video:batchAsyncGenerateVideoText',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Content-Type': 'text/plain;charset=UTF-8',
          'Origin': 'https://labs.google',
          'Referer': 'https://labs.google/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    log(`HTTP Response: ${result.status}`);
    log(`Body: ${result.body.substring(0, 500)}`);

    if (result.status === 200) {
      log('\n*** DIRECT HTTP REQUEST WORKS! ***');
      const resp = JSON.parse(result.body);
      log(`Media ID: ${resp.media?.[0]?.name}`);
      log(`Status: ${resp.media?.[0]?.mediaMetadata?.mediaStatus?.mediaGenerationStatus}`);
      log(`Remaining credits: ${resp.remainingCredits}`);
    }
  }

  ws.close();
  log('Done');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
