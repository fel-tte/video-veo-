/**
 * Comprehensive API parameter test for Google AI Sandbox (labs.google Flow).
 * Tests ALL possible parameters, models, aspect ratios, edge cases.
 * Auto-refreshes reCAPTCHA tokens from Chrome for each request.
 */
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const CDP_PORT = 9222;
const BASE_URL = 'https://aisandbox-pa.googleapis.com/v1';
const REPORT_PATH = 'c:/Users/Admin/Desktop/veo3/scripts/api-test-report.json';

// ====== CDP helpers ======
let _ws = null;

async function getWs() {
  if (_ws && _ws.readyState === WebSocket.OPEN) return _ws;
  const pages = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  const target = pages.find(p => p.url.includes('labs.google') && p.type === 'page');
  if (!target) throw new Error('No labs.google page');
  _ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => _ws.on('open', r));
  return _ws;
}

function cdpSend(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 99999);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
    function h(m) {
      const d = JSON.parse(m);
      if (d.id === id) { clearTimeout(t); ws.removeListener('message', h); if (d.error) reject(new Error(d.error.message)); else resolve(d.result); }
    }
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJS(expr) {
  const ws = await getWs();
  const { result } = await cdpSend(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (result.subtype === 'error') throw new Error(result.description);
  return result.value;
}

// ====== Token helpers ======
let accessToken = '';
let projectId = '';

async function refreshAccessToken() {
  const data = await evalJS(`(function(){
    if (!window.__NEXT_DATA__) return '{}';
    var s = window.__NEXT_DATA__.props.pageProps.session;
    return s ? JSON.stringify({access_token: s.access_token, expires: s.expires}) : '{}';
  })()`);
  const parsed = JSON.parse(data);
  if (!parsed.access_token) throw new Error('No access_token in __NEXT_DATA__');
  accessToken = parsed.access_token;
  log(`Token refreshed (expires: ${parsed.expires})`);
  return accessToken;
}

async function getRecaptchaToken() {
  const token = await evalJS(`(async function(){
    if (window.grecaptcha && window.grecaptcha.enterprise) {
      return await window.grecaptcha.enterprise.execute('6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV', {action:'generate'});
    }
    throw new Error('grecaptcha not available');
  })()`);
  if (!token) throw new Error('Empty reCAPTCHA token');
  return token;
}

async function getProjectId() {
  const url = await evalJS('window.location.href');
  const match = url.match(/flow\/project\/([a-f0-9-]+)/);
  if (match) return match[1];
  throw new Error('No project ID in URL: ' + url);
}

// ====== HTTP helper ======
function apiRequest(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const isFullUrl = path.startsWith('http');
    const urlObj = isFullUrl ? new URL(path) : new URL(BASE_URL + path);

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'text/plain;charset=UTF-8',
        'Origin': 'https://labs.google',
        'Referer': 'https://labs.google/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        ...extraHeaders
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ====== Test functions ======
const results = [];

async function runTest(name, fn) {
  log(`\n${'='.repeat(60)}`);
  log(`TEST: ${name}`);
  log('='.repeat(60));
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    log(`PASS (${elapsed}ms)`);
    results.push({ name, status: 'PASS', elapsed, result });
    return result;
  } catch (e) {
    const elapsed = Date.now() - start;
    log(`FAIL: ${e.message}`);
    results.push({ name, status: 'FAIL', elapsed, error: e.message });
    return null;
  }
}

// Build generate request body
function buildGenerateBody(opts = {}) {
  return {
    mediaGenerationContext: { batchId: opts.batchId || crypto.randomUUID() },
    clientContext: {
      projectId: opts.projectId || projectId,
      tool: opts.tool || 'PINHOLE',
      userPaygateTier: opts.userPaygateTier || 'PAYGATE_TIER_TWO',
      sessionId: opts.sessionId || ';' + Date.now(),
      recaptchaContext: {
        token: opts.recaptchaToken || '',
        applicationType: opts.applicationType || 'RECAPTCHA_APPLICATION_TYPE_WEB'
      }
    },
    requests: opts.requests || [{
      aspectRatio: opts.aspectRatio || 'VIDEO_ASPECT_RATIO_LANDSCAPE',
      seed: opts.seed || Math.floor(Math.random() * 10000),
      textInput: {
        structuredPrompt: {
          parts: [{ text: opts.prompt || 'test prompt' }]
        }
      },
      videoModelKey: opts.model || 'veo_3_1_t2v_fast_ultra',
      metadata: opts.metadata || {}
    }],
    useV2ModelConfig: opts.useV2ModelConfig !== undefined ? opts.useV2ModelConfig : true
  };
}

// ====== MAIN ======
async function main() {
  // Init
  await getWs();
  await refreshAccessToken();
  projectId = await getProjectId();
  log(`Project: ${projectId}`);

  // ============================================================
  // 1. GET CREDITS
  // ============================================================
  const credits = await runTest('GET /credits (with API key)', async () => {
    const r = await apiRequest('GET', '/credits?key=AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY');
    log(`Status: ${r.status}`);
    log(`Body: ${r.body}`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.body}`);
    return JSON.parse(r.body);
  });

  await runTest('GET /credits (without API key)', async () => {
    const r = await apiRequest('GET', '/credits');
    log(`Status: ${r.status} (expected 400/403)`);
    log(`Body: ${r.body.substring(0, 300)}`);
    return { status: r.status, body: r.body.substring(0, 300) };
  });

  await runTest('GET /credits (wrong API key)', async () => {
    const r = await apiRequest('GET', '/credits?key=INVALID_KEY');
    log(`Status: ${r.status}`);
    log(`Body: ${r.body.substring(0, 300)}`);
    return { status: r.status };
  });

  // ============================================================
  // 2. RECAPTCHA TOKEN GENERATION
  // ============================================================
  let recaptchaToken = '';
  await runTest('Get reCAPTCHA Enterprise token', async () => {
    recaptchaToken = await getRecaptchaToken();
    log(`Token length: ${recaptchaToken.length}`);
    log(`Token prefix: ${recaptchaToken.substring(0, 60)}...`);
    return { length: recaptchaToken.length };
  });

  // ============================================================
  // 3. TEST ALL MODELS
  // ============================================================
  const models = [
    'veo_3_1_t2v_fast_ultra',     // Veo 3.1 Fast (Ultra tier)
    'veo_3_1_t2v_fast',           // Veo 3.1 Fast (lower priority)
    'veo_3_1_t2v_quality',        // Veo 3.1 Quality
    'veo_2_t2v_fast',             // Veo 2 Fast
    'veo_2_t2v_quality',          // Veo 2 Quality
  ];

  const generatedMedia = []; // Track all generated media for status polling later

  for (const model of models) {
    await runTest(`Generate with model: ${model}`, async () => {
      recaptchaToken = await getRecaptchaToken();
      const body = buildGenerateBody({
        model,
        prompt: `API test - model ${model} - tiny cat sleeping`,
        recaptchaToken,
        seed: Math.floor(Math.random() * 10000)
      });
      const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
      log(`Status: ${r.status}`);
      if (r.status !== 200) {
        log(`Error: ${r.body.substring(0, 500)}`);
        throw new Error(`HTTP ${r.status}: ${r.body.substring(0, 300)}`);
      }
      const resp = JSON.parse(r.body);
      log(`Operations: ${resp.operations?.length}`);
      log(`Credits remaining: ${resp.remainingCredits}`);
      log(`Media IDs: ${resp.media?.map(m => m.name).join(', ')}`);
      log(`Status: ${resp.operations?.[0]?.status}`);
      if (resp.media) {
        resp.media.forEach(m => generatedMedia.push({ name: m.name, projectId, model }));
      }
      return {
        status: r.status,
        operations: resp.operations?.length,
        credits: resp.remainingCredits,
        mediaIds: resp.media?.map(m => m.name),
        opStatus: resp.operations?.[0]?.status
      };
    });
    await sleep(2000); // Small delay between generations
  }

  // ============================================================
  // 4. TEST ALL ASPECT RATIOS
  // ============================================================
  const aspectRatios = [
    'VIDEO_ASPECT_RATIO_LANDSCAPE',   // 16:9
    'VIDEO_ASPECT_RATIO_PORTRAIT',    // 9:16
    'VIDEO_ASPECT_RATIO_SQUARE',      // 1:1 (may not exist)
    'LANDSCAPE',                      // Short form test
    'PORTRAIT',                       // Short form test
  ];

  for (const ar of aspectRatios) {
    await runTest(`Generate with aspect ratio: ${ar}`, async () => {
      recaptchaToken = await getRecaptchaToken();
      const body = buildGenerateBody({
        aspectRatio: ar,
        prompt: `API test - aspect ${ar} - ocean wave`,
        recaptchaToken
      });
      const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
      log(`Status: ${r.status}`);
      if (r.status === 200) {
        const resp = JSON.parse(r.body);
        log(`Credits: ${resp.remainingCredits}, Media: ${resp.media?.map(m => m.name).join(', ')}`);
        if (resp.media) resp.media.forEach(m => generatedMedia.push({ name: m.name, projectId, ar }));
        return { status: 200, credits: resp.remainingCredits };
      } else {
        log(`Error body: ${r.body.substring(0, 500)}`);
        return { status: r.status, error: r.body.substring(0, 300) };
      }
    });
    await sleep(1500);
  }

  // ============================================================
  // 5. TEST MULTIPLE REQUESTS IN SINGLE BATCH
  // ============================================================
  await runTest('Multiple requests in single batch (2 prompts)', async () => {
    recaptchaToken = await getRecaptchaToken();
    const body = buildGenerateBody({ recaptchaToken });
    body.requests = [
      {
        aspectRatio: 'VIDEO_ASPECT_RATIO_LANDSCAPE',
        seed: 1111,
        textInput: { structuredPrompt: { parts: [{ text: 'batch test prompt 1 - sunset over ocean' }] } },
        videoModelKey: 'veo_3_1_t2v_fast_ultra',
        metadata: {}
      },
      {
        aspectRatio: 'VIDEO_ASPECT_RATIO_LANDSCAPE',
        seed: 2222,
        textInput: { structuredPrompt: { parts: [{ text: 'batch test prompt 2 - mountain landscape' }] } },
        videoModelKey: 'veo_3_1_t2v_fast_ultra',
        metadata: {}
      }
    ];
    const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
    log(`Status: ${r.status}`);
    const resp = JSON.parse(r.body);
    log(`Operations: ${resp.operations?.length}`);
    log(`Media count: ${resp.media?.length}`);
    log(`Media IDs: ${resp.media?.map(m => m.name).join(', ')}`);
    if (resp.media) resp.media.forEach(m => generatedMedia.push({ name: m.name, projectId }));
    return { status: r.status, operations: resp.operations?.length, mediaCount: resp.media?.length };
  });

  // ============================================================
  // 6. TEST PAYGATE TIERS
  // ============================================================
  const tiers = ['PAYGATE_TIER_ONE', 'PAYGATE_TIER_TWO', 'PAYGATE_TIER_THREE', 'PAYGATE_TIER_UNSPECIFIED'];
  for (const tier of tiers) {
    await runTest(`Generate with paygate tier: ${tier}`, async () => {
      recaptchaToken = await getRecaptchaToken();
      const body = buildGenerateBody({
        userPaygateTier: tier,
        prompt: `tier test ${tier} - small bird`,
        recaptchaToken
      });
      const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
      log(`Status: ${r.status}`);
      if (r.status === 200) {
        const resp = JSON.parse(r.body);
        log(`Credits: ${resp.remainingCredits}`);
        return { status: 200, credits: resp.remainingCredits };
      } else {
        log(`Error: ${r.body.substring(0, 400)}`);
        return { status: r.status, error: r.body.substring(0, 300) };
      }
    });
    await sleep(1500);
  }

  // ============================================================
  // 7. TEST TOOL PARAMETER VARIATIONS
  // ============================================================
  const tools = ['PINHOLE', 'FLOW', 'VIDEOFX', 'IMAGEFX', ''];
  for (const tool of tools) {
    await runTest(`Generate with tool: "${tool}"`, async () => {
      recaptchaToken = await getRecaptchaToken();
      const body = buildGenerateBody({
        tool: tool,
        prompt: `tool test ${tool} - gentle rain`,
        recaptchaToken
      });
      const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
      log(`Status: ${r.status}`);
      if (r.status === 200) {
        const resp = JSON.parse(r.body);
        return { status: 200, credits: resp.remainingCredits };
      } else {
        log(`Error: ${r.body.substring(0, 400)}`);
        return { status: r.status, error: r.body.substring(0, 300) };
      }
    });
    await sleep(1500);
  }

  // ============================================================
  // 8. TEST useV2ModelConfig
  // ============================================================
  for (const v2 of [true, false]) {
    await runTest(`Generate with useV2ModelConfig=${v2}`, async () => {
      recaptchaToken = await getRecaptchaToken();
      const body = buildGenerateBody({
        useV2ModelConfig: v2,
        prompt: `v2config test ${v2} - flower bloom`,
        recaptchaToken
      });
      const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
      log(`Status: ${r.status}`);
      if (r.status === 200) {
        const resp = JSON.parse(r.body);
        return { status: 200, credits: resp.remainingCredits };
      } else {
        log(`Error: ${r.body.substring(0, 400)}`);
        return { status: r.status, error: r.body.substring(0, 300) };
      }
    });
    await sleep(1500);
  }

  // ============================================================
  // 9. TEST EDGE CASES
  // ============================================================
  await runTest('Empty prompt', async () => {
    recaptchaToken = await getRecaptchaToken();
    const body = buildGenerateBody({ prompt: '', recaptchaToken });
    const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
    log(`Status: ${r.status}`);
    log(`Body: ${r.body.substring(0, 500)}`);
    return { status: r.status, body: r.body.substring(0, 300) };
  });

  await runTest('Very long prompt (2000 chars)', async () => {
    recaptchaToken = await getRecaptchaToken();
    const longPrompt = 'A beautiful cinematic scene of '.repeat(66).substring(0, 2000);
    const body = buildGenerateBody({ prompt: longPrompt, recaptchaToken });
    const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
    log(`Status: ${r.status}`);
    if (r.status === 200) {
      const resp = JSON.parse(r.body);
      return { status: 200, credits: resp.remainingCredits };
    }
    log(`Body: ${r.body.substring(0, 300)}`);
    return { status: r.status, body: r.body.substring(0, 300) };
  });

  await runTest('Special characters in prompt', async () => {
    recaptchaToken = await getRecaptchaToken();
    const body = buildGenerateBody({
      prompt: 'Test with special chars: "quotes", <tags>, &amp; symbols, 日本語テスト, emoji 🎬🌟',
      recaptchaToken
    });
    const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
    log(`Status: ${r.status}`);
    if (r.status === 200) { const resp = JSON.parse(r.body); return { status: 200, credits: resp.remainingCredits }; }
    log(`Body: ${r.body.substring(0, 300)}`);
    return { status: r.status };
  });

  await runTest('Invalid model key', async () => {
    recaptchaToken = await getRecaptchaToken();
    const body = buildGenerateBody({ model: 'invalid_model_xyz', recaptchaToken, prompt: 'invalid model test' });
    const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
    log(`Status: ${r.status}`);
    log(`Body: ${r.body.substring(0, 500)}`);
    return { status: r.status, body: r.body.substring(0, 300) };
  });

  await runTest('No recaptcha token', async () => {
    const body = buildGenerateBody({ recaptchaToken: '', prompt: 'no recaptcha test' });
    const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
    log(`Status: ${r.status}`);
    log(`Body: ${r.body.substring(0, 500)}`);
    return { status: r.status, body: r.body.substring(0, 300) };
  });

  await runTest('Invalid recaptcha token', async () => {
    const body = buildGenerateBody({ recaptchaToken: 'INVALID_TOKEN_12345', prompt: 'bad recaptcha test' });
    const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
    log(`Status: ${r.status}`);
    log(`Body: ${r.body.substring(0, 500)}`);
    return { status: r.status, body: r.body.substring(0, 300) };
  });

  await runTest('Invalid project ID', async () => {
    recaptchaToken = await getRecaptchaToken();
    const body = buildGenerateBody({ projectId: 'nonexistent-project-id', recaptchaToken, prompt: 'bad project test' });
    const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
    log(`Status: ${r.status}`);
    log(`Body: ${r.body.substring(0, 500)}`);
    return { status: r.status, body: r.body.substring(0, 300) };
  });

  await runTest('No Authorization header', async () => {
    const saved = accessToken;
    accessToken = '';
    const body = buildGenerateBody({ prompt: 'no auth test' });
    body.clientContext.recaptchaContext.token = 'dummy';
    const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
    accessToken = saved;
    log(`Status: ${r.status}`);
    log(`Body: ${r.body.substring(0, 300)}`);
    return { status: r.status };
  });

  await runTest('Expired/invalid token', async () => {
    const saved = accessToken;
    accessToken = 'ya29.INVALID_EXPIRED_TOKEN';
    recaptchaToken = await getRecaptchaToken();
    const body = buildGenerateBody({ recaptchaToken, prompt: 'expired token test' });
    const r = await apiRequest('POST', '/video:batchAsyncGenerateVideoText', body);
    accessToken = saved;
    log(`Status: ${r.status}`);
    log(`Body: ${r.body.substring(0, 300)}`);
    return { status: r.status };
  });

  // ============================================================
  // 10. POLL STATUS
  // ============================================================
  if (generatedMedia.length > 0) {
    await runTest('Poll generation status (batch)', async () => {
      const media = generatedMedia.slice(0, 4).map(m => ({ name: m.name, projectId: m.projectId }));
      const r = await apiRequest('POST', '/video:batchCheckAsyncVideoGenerationStatus', { media });
      log(`Status: ${r.status}`);
      if (r.status === 200) {
        const resp = JSON.parse(r.body);
        log(`Media results: ${resp.media?.length}`);
        resp.media?.forEach(m => {
          const s = m.mediaMetadata?.mediaStatus?.mediaGenerationStatus;
          log(`  ${m.name}: ${s}`);
        });
        return { status: 200, mediaCount: resp.media?.length, statuses: resp.media?.map(m => m.mediaMetadata?.mediaStatus?.mediaGenerationStatus) };
      }
      return { status: r.status };
    });

    // Wait for at least one to complete
    log('\n--- Waiting 30s for some generations to complete... ---');
    await sleep(30000);

    await runTest('Poll status after 30s wait', async () => {
      const media = generatedMedia.slice(0, 6).map(m => ({ name: m.name, projectId: m.projectId }));
      const r = await apiRequest('POST', '/video:batchCheckAsyncVideoGenerationStatus', { media });
      if (r.status === 200) {
        const resp = JSON.parse(r.body);
        const statuses = {};
        resp.media?.forEach(m => {
          const s = m.mediaMetadata?.mediaStatus?.mediaGenerationStatus;
          statuses[s] = (statuses[s] || 0) + 1;
          log(`  ${m.name}: ${s}`);
        });
        log(`Status counts: ${JSON.stringify(statuses)}`);

        // Capture full response structure of a completed one
        const completed = resp.media?.find(m => m.mediaMetadata?.mediaStatus?.mediaGenerationStatus === 'MEDIA_GENERATION_STATUS_COMPLETED');
        if (completed) {
          log(`\nFull completed media structure:`);
          log(JSON.stringify(completed, null, 2).substring(0, 2000));
        }
        return { statuses, fullResponse: resp.media?.[0] };
      }
      return { status: r.status };
    });
  }

  // ============================================================
  // 11. VIDEO DOWNLOAD URL (tRPC)
  // ============================================================
  if (generatedMedia.length > 0) {
    const mediaId = generatedMedia[0].name;

    await runTest(`Get video URL redirect (mediaId: ${mediaId})`, async () => {
      const url = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}&mediaUrlType=MEDIA_URL_TYPE_UNSPECIFIED`;
      // Need cookies for this endpoint - use browser fetch instead
      const result = await evalJS(`(async function(){
        try {
          var r = await fetch('/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}&mediaUrlType=MEDIA_URL_TYPE_UNSPECIFIED', {redirect:'manual'});
          var loc = r.headers.get('location');
          return JSON.stringify({status: r.status, location: loc, type: r.type, url: r.url});
        } catch(e) { return JSON.stringify({error: e.message}); }
      })()`);
      log(`Result: ${result}`);
      return JSON.parse(result);
    });

    // Test different mediaUrlTypes
    const urlTypes = ['MEDIA_URL_TYPE_UNSPECIFIED', 'MEDIA_URL_TYPE_THUMBNAIL', 'MEDIA_URL_TYPE_VIDEO', 'MEDIA_URL_TYPE_DOWNLOAD'];
    for (const urlType of urlTypes) {
      await runTest(`Media URL type: ${urlType}`, async () => {
        const result = await evalJS(`(async function(){
          try {
            var r = await fetch('/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}&mediaUrlType=${urlType}');
            if (r.redirected) return JSON.stringify({redirected: true, finalUrl: r.url.substring(0, 200)});
            var text = await r.text();
            return JSON.stringify({status: r.status, body: text.substring(0, 500)});
          } catch(e) { return JSON.stringify({error: e.message}); }
        })()`);
        log(`Result: ${result}`);
        return JSON.parse(result);
      });
    }
  }

  // ============================================================
  // 12. WORKFLOW ENDPOINTS
  // ============================================================
  await runTest('List workflows (GET /flowWorkflows)', async () => {
    const r = await apiRequest('GET', `/flowWorkflows?projectId=${projectId}`);
    log(`Status: ${r.status}`);
    log(`Body preview: ${r.body.substring(0, 500)}`);
    return { status: r.status, bodyPreview: r.body.substring(0, 300) };
  });

  // ============================================================
  // 13. EXPLORE OTHER ENDPOINTS
  // ============================================================
  const explorationEndpoints = [
    { method: 'GET', path: '/video:listModels', desc: 'List available models' },
    { method: 'GET', path: '/models', desc: 'List models (alt)' },
    { method: 'GET', path: '/image:listModels', desc: 'List image models' },
    { method: 'POST', path: '/image:batchAsyncGenerateImageText', desc: 'Image generation endpoint' },
    { method: 'GET', path: `/flowProjects/${projectId}`, desc: 'Get project details' },
    { method: 'GET', path: `/flowProjects`, desc: 'List projects' },
    { method: 'GET', path: '/userProfile', desc: 'User profile' },
    { method: 'GET', path: '/subscription', desc: 'Subscription info' },
  ];

  for (const ep of explorationEndpoints) {
    await runTest(`Explore: ${ep.method} ${ep.path} (${ep.desc})`, async () => {
      const r = await apiRequest(ep.method, ep.path);
      log(`Status: ${r.status}`);
      log(`Body: ${r.body.substring(0, 500)}`);
      return { status: r.status, body: r.body.substring(0, 400) };
    });
  }

  // ============================================================
  // 14. TRPC ENDPOINTS (via browser fetch with cookies)
  // ============================================================
  const trpcEndpoints = [
    'general.fetchUserAcknowledgement?input={"json":{"acknowledgementVersion":"FLOW_IMAGE_UPLOAD_CONSENT"}}',
    'media.getMediaUrlRedirect?name=test&mediaUrlType=MEDIA_URL_TYPE_UNSPECIFIED',
    'general.fetchSubscription',
    'general.fetchUserProfile',
    'project.listProjects',
    'project.getProject?input={"json":{"projectId":"' + projectId + '"}}',
  ];

  for (const ep of trpcEndpoints) {
    await runTest(`tRPC: ${ep.split('?')[0]}`, async () => {
      const result = await evalJS(`(async function(){
        try {
          var r = await fetch('/fx/api/trpc/${ep}');
          var text = await r.text();
          return JSON.stringify({status: r.status, body: text.substring(0, 800)});
        } catch(e) { return JSON.stringify({error: e.message}); }
      })()`);
      const parsed = JSON.parse(result);
      log(`Status: ${parsed.status}`);
      log(`Body: ${parsed.body?.substring(0, 400) || parsed.error}`);
      return parsed;
    });
  }

  // ============================================================
  // 15. IMAGE GENERATION TEST
  // ============================================================
  await runTest('Image generation (batchAsyncGenerateImageText)', async () => {
    recaptchaToken = await getRecaptchaToken();
    const body = {
      mediaGenerationContext: { batchId: crypto.randomUUID() },
      clientContext: {
        projectId,
        tool: 'PINHOLE',
        userPaygateTier: 'PAYGATE_TIER_TWO',
        sessionId: ';' + Date.now(),
        recaptchaContext: {
          token: recaptchaToken,
          applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB'
        }
      },
      requests: [{
        aspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
        seed: Math.floor(Math.random() * 10000),
        textInput: { structuredPrompt: { parts: [{ text: 'a cute cat wearing sunglasses' }] } },
        imageModelKey: 'imagen_3_landscape',
        metadata: {}
      }],
      useV2ModelConfig: true
    };
    const r = await apiRequest('POST', '/image:batchAsyncGenerateImageText', body);
    log(`Status: ${r.status}`);
    log(`Body: ${r.body.substring(0, 500)}`);
    return { status: r.status, body: r.body.substring(0, 400) };
  });

  // Try different image model keys
  const imageModels = ['imagen_3_landscape', 'nano_banana_2', 'imagen_3_fast', 'imagen_3'];
  for (const im of imageModels) {
    await runTest(`Image model: ${im}`, async () => {
      recaptchaToken = await getRecaptchaToken();
      const body = {
        mediaGenerationContext: { batchId: crypto.randomUUID() },
        clientContext: {
          projectId, tool: 'PINHOLE', userPaygateTier: 'PAYGATE_TIER_TWO',
          sessionId: ';' + Date.now(),
          recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
        },
        requests: [{
          aspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
          seed: Math.floor(Math.random() * 10000),
          textInput: { structuredPrompt: { parts: [{ text: 'a peaceful garden' }] } },
          imageModelKey: im,
          metadata: {}
        }],
        useV2ModelConfig: true
      };
      const r = await apiRequest('POST', '/image:batchAsyncGenerateImageText', body);
      log(`Status: ${r.status}`);
      if (r.status === 200) {
        const resp = JSON.parse(r.body);
        log(`Credits: ${resp.remainingCredits}`);
        return { status: 200, credits: resp.remainingCredits };
      }
      log(`Error: ${r.body.substring(0, 400)}`);
      return { status: r.status, body: r.body.substring(0, 300) };
    });
    await sleep(1000);
  }

  // ============================================================
  // SAVE FULL REPORT
  // ============================================================
  const report = {
    timestamp: new Date().toISOString(),
    projectId,
    totalTests: results.length,
    passed: results.filter(r => r.status === 'PASS').length,
    failed: results.filter(r => r.status === 'FAIL').length,
    results,
    generatedMedia
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  log(`\nReport saved: ${REPORT_PATH}`);

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('TEST SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total: ${results.length} | Pass: ${report.passed} | Fail: ${report.failed}`);
  console.log('\nResults:');
  results.forEach(r => {
    const icon = r.status === 'PASS' ? 'OK' : 'FAIL';
    console.log(`  [${icon}] ${r.name} (${r.elapsed}ms)`);
    if (r.status === 'FAIL') console.log(`       Error: ${r.error}`);
  });
  console.log('='.repeat(70));

  if (_ws) _ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
