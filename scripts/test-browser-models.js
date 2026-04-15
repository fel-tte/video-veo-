// Test all models via CDP browser automation - check what's actually available in the UI
const WebSocket = require('ws');
const http = require('http');

const CDP_URL = 'http://127.0.0.1:9222';

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function getFlowPage() {
  const resp = await fetch(`${CDP_URL}/json`);
  const pages = await resp.json();
  const page = pages.find(p => p.url.includes('labs.google/fx'));
  if (!page) throw new Error('No Flow page found. Open https://labs.google/fx/ in Chrome first.');
  return page;
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
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'eval error');
  }
  return result.result.value;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const page = await getFlowPage();
  log(`Connected to: ${page.url}`);
  const cdp = await connectCDP(page);

  try {
    // Step 1: Check what's on the page - get all model/settings info from UI
    log('\n=== STEP 1: Scan UI for available settings ===');

    // Find all buttons with aria-haspopup="menu" (settings dropdowns)
    const settingsButtons = await evaluate(cdp, `
      JSON.stringify(
        Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
          .map(b => ({
            text: b.textContent.trim().substring(0, 100),
            ariaLabel: b.getAttribute('aria-label'),
            rect: b.getBoundingClientRect().toJSON()
          }))
      )
    `);
    log(`Settings buttons: ${settingsButtons}`);

    // Step 2: Find and click the settings dropdown (the one with crop_ icon)
    log('\n=== STEP 2: Open settings dropdown ===');
    const clickedSettings = await evaluate(cdp, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'));
        const settingsBtn = btns.find(b => b.textContent.includes('crop_'));
        if (!settingsBtn) return 'NO_SETTINGS_BTN';
        settingsBtn.click();
        return 'CLICKED: ' + settingsBtn.textContent.trim().substring(0, 80);
      })()
    `);
    log(clickedSettings);
    await sleep(500);

    // Step 3: Read all tab items (settings options)
    log('\n=== STEP 3: Read settings tabs ===');
    const tabs = await evaluate(cdp, `
      JSON.stringify(
        Array.from(document.querySelectorAll('[role="tab"]'))
          .map(t => ({
            text: t.textContent.trim(),
            state: t.getAttribute('data-state'),
            ariaSelected: t.getAttribute('aria-selected')
          }))
      )
    `);
    log(`Tabs: ${tabs}`);

    // Step 4: Read all menu items (for model sub-dropdown)
    const menuItems = await evaluate(cdp, `
      JSON.stringify(
        Array.from(document.querySelectorAll('[role="menuitem"]'))
          .map(m => ({
            text: m.textContent.trim(),
            dataState: m.getAttribute('data-state')
          }))
      )
    `);
    log(`Menu items: ${menuItems}`);

    // Step 5: Look for aspect ratio options
    log('\n=== STEP 4: Check aspect ratio options ===');
    const aspectBtns = await evaluate(cdp, `
      JSON.stringify(
        Array.from(document.querySelectorAll('[role="tab"]'))
          .filter(t => {
            const txt = t.textContent.trim();
            return txt.includes('16:9') || txt.includes('9:16') || txt.includes('crop_');
          })
          .map(t => ({
            text: t.textContent.trim(),
            state: t.getAttribute('data-state')
          }))
      )
    `);
    log(`Aspect ratio tabs: ${aspectBtns}`);

    // Step 6: Look for model selection - click on model tab if exists
    log('\n=== STEP 5: Check model options ===');
    // First check if there's a model-related tab
    const modelTab = await evaluate(cdp, `
      (() => {
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
        // Look for tabs containing model-related text
        const found = tabs.map(t => ({
          text: t.textContent.trim(),
          state: t.getAttribute('data-state'),
          hasSubmenu: t.querySelector('[aria-haspopup]') !== null
        }));
        return JSON.stringify(found);
      })()
    `);
    log(`All tabs detail: ${modelTab}`);

    // Step 7: Look for any dropdown/select with model names
    log('\n=== STEP 6: Search for model names in page ===');
    const modelSearch = await evaluate(cdp, `
      (() => {
        const body = document.body.innerText;
        const models = ['Veo 3', 'Veo 2', 'Veo3', 'Veo2', 'veo_3', 'veo_2',
                        'Fast', 'Quality', 'Ultra', 'Standard',
                        'Imagen', 'imagen'];
        const found = {};
        models.forEach(m => {
          const idx = body.indexOf(m);
          if (idx >= 0) {
            found[m] = body.substring(Math.max(0, idx-20), idx+m.length+20).trim();
          }
        });
        return JSON.stringify(found);
      })()
    `);
    log(`Model text found: ${modelSearch}`);

    // Step 8: Close dropdown and check the generate form area
    log('\n=== STEP 7: Close dropdown, inspect generate form ===');
    await evaluate(cdp, `document.body.click()`);
    await sleep(300);

    // Check all visible text in the bottom area (where settings/form is)
    const bottomArea = await evaluate(cdp, `
      (() => {
        // Find all elements in the bottom half of viewport
        const els = document.querySelectorAll('*');
        const texts = new Set();
        for (const el of els) {
          const rect = el.getBoundingClientRect();
          if (rect.top > 500 && el.children.length === 0 && el.textContent.trim()) {
            texts.add(el.textContent.trim());
          }
        }
        return JSON.stringify([...texts].slice(0, 50));
      })()
    `);
    log(`Bottom area texts: ${bottomArea}`);

    // Step 9: Now test actual API generation with each model via direct HTTP
    log('\n=== STEP 8: Test each model via API (with fresh token + recaptcha) ===');

    // Get fresh token
    const tokenData = await evaluate(cdp, `
      (() => {
        if (window.__NEXT_DATA__?.props?.pageProps?.session) {
          const s = window.__NEXT_DATA__.props.pageProps.session;
          return JSON.stringify({ token: s.access_token, expires: s.expires });
        }
        return '{}';
      })()
    `);
    const { token } = JSON.parse(tokenData);
    if (!token) { log('ERROR: No token!'); return; }
    log(`Token OK (${token.substring(0, 15)}...)`);

    // Extract project ID from URL
    const projectId = await evaluate(cdp, `
      (() => {
        const m = window.location.href.match(/project\\/([^\\/?]+)/);
        return m ? m[1] : '';
      })()
    `);
    log(`Project: ${projectId}`);

    // Models to test
    const models = [
      { key: 'veo_3_1_t2v_fast_ultra', name: 'Veo 3.1 Fast Ultra' },
      { key: 'veo_3_1_t2v_fast', name: 'Veo 3.1 Fast' },
      { key: 'veo_3_1_t2v_quality', name: 'Veo 3.1 Quality' },
      { key: 'veo_3_t2v_fast', name: 'Veo 3 Fast (alt key)' },
      { key: 'veo_3_t2v_quality', name: 'Veo 3 Quality (alt key)' },
      { key: 'veo_3_1_t2v_quality_ultra', name: 'Veo 3.1 Quality Ultra (guess)' },
      { key: 'veo_2_t2v_fast', name: 'Veo 2 Fast' },
      { key: 'veo_2_t2v_quality', name: 'Veo 2 Quality' },
      { key: 'veo_2_t2v_fast_ultra', name: 'Veo 2 Fast Ultra (guess)' },
    ];

    const results = [];

    for (const model of models) {
      log(`\n--- Testing model: ${model.name} (${model.key}) ---`);

      // Get fresh recaptcha for each request
      let recaptchaToken = '';
      try {
        recaptchaToken = await evaluate(cdp, `
          window.grecaptcha.enterprise.execute('6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV', { action: 'generate' })
        `);
        log(`  reCAPTCHA OK (${recaptchaToken.substring(0, 30)}...)`);
      } catch (e) {
        log(`  reCAPTCHA failed: ${e.message}`);
      }

      const body = JSON.stringify({
        mediaGenerationContext: { batchId: crypto.randomUUID() },
        clientContext: {
          projectId: projectId,
          tool: 'PINHOLE',
          userPaygateTier: 'PAYGATE_TIER_TWO',
          sessionId: `;${Date.now()}`,
          recaptchaContext: {
            token: recaptchaToken,
            applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB'
          }
        },
        requests: [{
          aspectRatio: 'VIDEO_ASPECT_RATIO_LANDSCAPE',
          seed: Math.floor(Math.random() * 10000),
          textInput: { structuredPrompt: { parts: [{ text: `model test ${model.key}` }] } },
          videoModelKey: model.key,
          metadata: {}
        }],
        useV2ModelConfig: true
      });

      try {
        const resp = await evaluate(cdp, `
          fetch('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ${token}',
              'Content-Type': 'text/plain;charset=UTF-8',
              'Origin': 'https://labs.google',
              'Referer': 'https://labs.google/'
            },
            body: ${JSON.stringify(body)}
          }).then(async r => {
            const text = await r.text();
            let parsed = null;
            try { parsed = JSON.parse(text); } catch(e) {}
            return JSON.stringify({ status: r.status, body: parsed || text });
          })
        `);

        const result = JSON.parse(resp);
        log(`  Status: ${result.status}`);

        if (result.status === 200) {
          const b = result.body;
          const mediaId = b.media?.[0]?.name || b.operations?.[0]?.operation?.name || 'unknown';
          const credits = b.remainingCredits;
          log(`  ✓ SUCCESS — media: ${mediaId}, credits: ${credits}`);
          results.push({ model: model.key, name: model.name, status: 'OK', httpStatus: 200, credits });
        } else {
          const errMsg = result.body?.error?.message || JSON.stringify(result.body).substring(0, 200);
          const errReason = result.body?.error?.details?.[0]?.reason || '';
          log(`  ✗ FAILED — ${result.status}: ${errMsg} ${errReason}`);
          results.push({ model: model.key, name: model.name, status: 'FAIL', httpStatus: result.status, error: errMsg, reason: errReason });
        }
      } catch (e) {
        log(`  ✗ ERROR: ${e.message}`);
        results.push({ model: model.key, name: model.name, status: 'ERROR', error: e.message });
      }

      await sleep(2000); // delay between tests
    }

    // Step 10: Test aspect ratios
    log('\n=== STEP 9: Test aspect ratios ===');
    const aspectRatios = [
      'VIDEO_ASPECT_RATIO_LANDSCAPE',
      'VIDEO_ASPECT_RATIO_PORTRAIT',
      'VIDEO_ASPECT_RATIO_SQUARE',
      'VIDEO_ASPECT_RATIO_UNSPECIFIED',
    ];

    for (const ar of aspectRatios) {
      log(`\n--- Testing aspect ratio: ${ar} ---`);

      let recaptchaToken = '';
      try {
        recaptchaToken = await evaluate(cdp, `
          window.grecaptcha.enterprise.execute('6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV', { action: 'generate' })
        `);
      } catch (e) {}

      const body = JSON.stringify({
        mediaGenerationContext: { batchId: crypto.randomUUID() },
        clientContext: {
          projectId: projectId,
          tool: 'PINHOLE',
          userPaygateTier: 'PAYGATE_TIER_TWO',
          sessionId: `;${Date.now()}`,
          recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
        },
        requests: [{
          aspectRatio: ar,
          seed: Math.floor(Math.random() * 10000),
          textInput: { structuredPrompt: { parts: [{ text: `aspect ratio test ${ar}` }] } },
          videoModelKey: 'veo_3_1_t2v_fast_ultra',
          metadata: {}
        }],
        useV2ModelConfig: true
      });

      try {
        const resp = await evaluate(cdp, `
          fetch('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ${token}',
              'Content-Type': 'text/plain;charset=UTF-8',
              'Origin': 'https://labs.google',
              'Referer': 'https://labs.google/'
            },
            body: ${JSON.stringify(body)}
          }).then(async r => {
            const text = await r.text();
            let parsed = null;
            try { parsed = JSON.parse(text); } catch(e) {}
            return JSON.stringify({ status: r.status, body: parsed || text });
          })
        `);

        const result = JSON.parse(resp);
        if (result.status === 200) {
          log(`  ✓ ${ar} — OK (credits: ${result.body.remainingCredits})`);
          results.push({ type: 'aspect', value: ar, status: 'OK' });
        } else {
          log(`  ✗ ${ar} — ${result.status}: ${result.body?.error?.message || ''}`);
          results.push({ type: 'aspect', value: ar, status: 'FAIL', httpStatus: result.status });
        }
      } catch (e) {
        log(`  ✗ ${ar} — ERROR: ${e.message}`);
        results.push({ type: 'aspect', value: ar, status: 'ERROR', error: e.message });
      }

      await sleep(2000);
    }

    // Step 11: Wait and poll status of all successful generations
    log('\n=== STEP 10: Wait 60s then poll all media status ===');
    const successMedia = results.filter(r => r.status === 'OK' && r.type !== 'aspect');
    // Collect all media IDs from the generate step - we need to re-check
    // For now poll all media in project
    log('Waiting 60s for generations to process...');
    await sleep(60000);

    // Poll status of all media we generated
    const allMediaForPoll = [];
    // We need to re-collect - let's poll the whole batch
    const pollBody = JSON.stringify({
      media: results
        .filter(r => r.status === 'OK')
        .map(r => ({ name: r.model || r.value, projectId: projectId }))
    });

    // Actually let's just check all recent media via a simpler approach
    log('\nChecking generation results via status API...');

    // Final summary
    log('\n======================================================================');
    log('FINAL RESULTS');
    log('======================================================================');

    const modelResults = results.filter(r => !r.type);
    const aspectResults = results.filter(r => r.type === 'aspect');

    log('\nModels:');
    for (const r of modelResults) {
      const icon = r.status === 'OK' ? '✓' : '✗';
      log(`  ${icon} ${r.name} (${r.model}) — ${r.status}${r.httpStatus ? ' [' + r.httpStatus + ']' : ''}${r.error ? ': ' + r.error.substring(0, 80) : ''}${r.reason ? ' (' + r.reason + ')' : ''}`);
    }

    log('\nAspect Ratios:');
    for (const r of aspectResults) {
      const icon = r.status === 'OK' ? '✓' : '✗';
      log(`  ${icon} ${r.value} — ${r.status}${r.httpStatus ? ' [' + r.httpStatus + ']' : ''}`);
    }

    // Save results
    const fs = require('fs');
    fs.writeFileSync('scripts/browser-model-test-results.json', JSON.stringify(results, null, 2));
    log('\nResults saved to scripts/browser-model-test-results.json');

  } finally {
    cdp.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
