// Test image generation capabilities via CDP browser
const WebSocket = require('ws');

const CDP_URL = 'http://127.0.0.1:9222';
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

async function getFlowPage() {
  const resp = await fetch(`${CDP_URL}/json`);
  const pages = await resp.json();
  const page = pages.find(p => p.url.includes('labs.google/fx'));
  if (!page) throw new Error('No Flow page found');
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
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'eval error');
  return result.result.value;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const page = await getFlowPage();
  log(`Connected to: ${page.url}`);
  const cdp = await connectCDP(page);

  try {
    // Get token and project
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
    log(`Project: ${projectId}`);

    // Step 1: Check UI for image/video toggle
    log('\n=== STEP 1: Check UI for media type options ===');
    const uiScan = await evaluate(cdp, `
      (() => {
        const all = document.body.innerText;
        const keywords = ['Image', 'Video', 'Photo', 'Picture', 'Imagen', 'ImageFX', 'MusicFX', 'Audio'];
        const found = {};
        keywords.forEach(k => {
          const regex = new RegExp(k, 'gi');
          const matches = all.match(regex);
          if (matches) found[k] = matches.length;
        });
        return JSON.stringify(found);
      })()
    `);
    log(`Keywords in page: ${uiScan}`);

    // Check the settings dropdown content more carefully
    log('\n=== STEP 2: Open settings and check for Image/Video toggle ===');
    await evaluate(cdp, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'));
        const settingsBtn = btns.find(b => b.textContent.includes('crop_'));
        if (settingsBtn) settingsBtn.click();
        return !!settingsBtn;
      })()
    `);
    await sleep(800);

    // Read the full popup/dropdown content
    const popupContent = await evaluate(cdp, `
      (() => {
        // Check for popover, dialog, dropdown, menu
        const selectors = [
          '[role="menu"]', '[role="dialog"]', '[role="listbox"]',
          '[data-state="open"]', '.popover', '[role="tablist"]',
          '[data-radix-popper-content-wrapper]'
        ];
        const results = {};
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          if (els.length) {
            results[sel] = Array.from(els).map(e => ({
              tag: e.tagName,
              text: e.textContent.trim().substring(0, 300),
              children: e.children.length
            }));
          }
        }
        return JSON.stringify(results);
      })()
    `);
    log(`Popup content: ${popupContent}`);

    // Close popup
    await evaluate(cdp, `document.body.click()`);
    await sleep(300);

    // Step 3: Intercept network to find image endpoints
    log('\n=== STEP 3: Setup network intercept and try switching to Image mode ===');

    // Enable network domain to capture requests
    await cdp.send('Network.enable');

    const capturedRequests = [];
    // We'll capture via JS fetch override instead
    await evaluate(cdp, `
      (() => {
        window.__capturedFetches = [];
        const origFetch = window.fetch;
        window.fetch = async function(...args) {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
          window.__capturedFetches.push({ url, method: args[1]?.method || 'GET', time: Date.now() });
          return origFetch.apply(this, args);
        };
        return 'fetch intercepted';
      })()
    `);

    // Step 4: Try to find and click "Image" or "Video" toggle in UI
    log('\n=== STEP 4: Look for media type selector ===');
    const mediaTypeSearch = await evaluate(cdp, `
      (() => {
        // Search all clickable elements for "Image" or "Video" text
        const clickables = document.querySelectorAll('button, [role="tab"], [role="menuitem"], [role="option"], a, [tabindex]');
        const found = [];
        for (const el of clickables) {
          const text = el.textContent.trim();
          if (text === 'Video' || text === 'Image' || text === 'video' || text === 'image' ||
              text.includes('Image') || text.includes('Video')) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              found.push({
                tag: el.tagName,
                role: el.getAttribute('role'),
                text: text.substring(0, 80),
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
              });
            }
          }
        }
        return JSON.stringify(found);
      })()
    `);
    log(`Media type elements: ${mediaTypeSearch}`);

    // Step 5: Try clicking the settings button and look for Video/Image toggle
    log('\n=== STEP 5: Re-open settings, look for Video/Image inside ===');
    await evaluate(cdp, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'));
        const settingsBtn = btns.find(b => b.textContent.includes('crop_') || b.textContent.includes('Video'));
        if (settingsBtn) settingsBtn.click();
        return settingsBtn?.textContent?.trim() || 'none';
      })()
    `);
    await sleep(800);

    // Now scan ALL visible elements in dropdown area for Video/Image
    const dropdownScan = await evaluate(cdp, `
      (() => {
        const allEls = document.querySelectorAll('*');
        const items = [];
        for (const el of allEls) {
          const rect = el.getBoundingClientRect();
          // Only visible elements
          if (rect.width === 0 || rect.height === 0) continue;
          const text = el.textContent?.trim();
          if (!text) continue;
          // Check if it's a leaf node (no child text nodes differ from parent)
          if (el.children.length === 0 || el.childNodes.length === 1) {
            if (text.length < 50 && text.length > 0) {
              const style = window.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                items.push({
                  text,
                  tag: el.tagName,
                  role: el.getAttribute('role'),
                  y: Math.round(rect.y),
                  clickable: el.tagName === 'BUTTON' || el.getAttribute('role') === 'menuitem' || el.getAttribute('role') === 'tab'
                });
              }
            }
          }
        }
        // Deduplicate and sort by y
        const seen = new Set();
        return JSON.stringify(items.filter(i => {
          const key = i.text + i.y;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).sort((a, b) => a.y - b.y).slice(0, 60));
      })()
    `);
    log(`All visible leaf elements: ${dropdownScan}`);

    // Close
    await evaluate(cdp, `document.body.click()`);
    await sleep(300);

    // Step 6: Try image generation API endpoints directly
    log('\n=== STEP 6: Test image API endpoints ===');

    const getRecaptcha = async () => {
      try {
        return await evaluate(cdp, `
          window.grecaptcha.enterprise.execute('6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV', { action: 'generate' })
        `);
      } catch(e) { return ''; }
    };

    // Test various image endpoints
    const imageEndpoints = [
      {
        name: 'image:batchAsyncGenerateImageText (via browser fetch)',
        test: async () => {
          const rc = await getRecaptcha();
          return await evaluate(cdp, `
            fetch('https://aisandbox-pa.googleapis.com/v1/image:batchAsyncGenerateImageText', {
              method: 'POST',
              headers: {
                'Authorization': 'Bearer ${token}',
                'Content-Type': 'text/plain;charset=UTF-8',
                'Origin': 'https://labs.google',
                'Referer': 'https://labs.google/'
              },
              body: JSON.stringify({
                mediaGenerationContext: { batchId: crypto.randomUUID() },
                clientContext: {
                  projectId: '${projectId}',
                  tool: 'PINHOLE',
                  userPaygateTier: 'PAYGATE_TIER_TWO',
                  sessionId: ';' + Date.now(),
                  recaptchaContext: { token: '${rc}', applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
                },
                requests: [{
                  textInput: { structuredPrompt: { parts: [{ text: 'a beautiful sunset over mountains' }] } },
                  imageModelKey: 'imagen_3',
                  metadata: {}
                }],
                useV2ModelConfig: true
              })
            }).then(async r => {
              const t = await r.text();
              return JSON.stringify({ status: r.status, body: t.substring(0, 500) });
            })
          `);
        }
      },
      {
        name: 'image:batchAsyncGenerateImage (alt endpoint)',
        test: async () => {
          const rc = await getRecaptcha();
          return await evaluate(cdp, `
            fetch('https://aisandbox-pa.googleapis.com/v1/image:batchAsyncGenerateImage', {
              method: 'POST',
              headers: {
                'Authorization': 'Bearer ${token}',
                'Content-Type': 'text/plain;charset=UTF-8',
                'Origin': 'https://labs.google',
                'Referer': 'https://labs.google/'
              },
              body: JSON.stringify({
                mediaGenerationContext: { batchId: crypto.randomUUID() },
                clientContext: {
                  projectId: '${projectId}',
                  tool: 'IMAGEFX',
                  userPaygateTier: 'PAYGATE_TIER_TWO',
                  sessionId: ';' + Date.now(),
                  recaptchaContext: { token: '${rc}', applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
                },
                requests: [{
                  textInput: { structuredPrompt: { parts: [{ text: 'a beautiful sunset' }] } },
                  imageModelKey: 'imagen_3',
                  metadata: {}
                }],
                useV2ModelConfig: true
              })
            }).then(async r => {
              const t = await r.text();
              return JSON.stringify({ status: r.status, body: t.substring(0, 500) });
            })
          `);
        }
      },
      {
        name: 'Try video endpoint with image model key',
        test: async () => {
          const rc = await getRecaptcha();
          return await evaluate(cdp, `
            fetch('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText', {
              method: 'POST',
              headers: {
                'Authorization': 'Bearer ${token}',
                'Content-Type': 'text/plain;charset=UTF-8',
                'Origin': 'https://labs.google',
                'Referer': 'https://labs.google/'
              },
              body: JSON.stringify({
                mediaGenerationContext: { batchId: crypto.randomUUID() },
                clientContext: {
                  projectId: '${projectId}',
                  tool: 'PINHOLE',
                  userPaygateTier: 'PAYGATE_TIER_TWO',
                  sessionId: ';' + Date.now(),
                  recaptchaContext: { token: '${rc}', applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
                },
                requests: [{
                  textInput: { structuredPrompt: { parts: [{ text: 'a sunset' }] } },
                  imageModelKey: 'imagen_3',
                  metadata: {}
                }],
                useV2ModelConfig: true
              })
            }).then(async r => {
              const t = await r.text();
              return JSON.stringify({ status: r.status, body: t.substring(0, 500) });
            })
          `);
        }
      },
      {
        name: 'ImageFX tool endpoint (aisandbox-pa)',
        test: async () => {
          const rc = await getRecaptcha();
          return await evaluate(cdp, `
            fetch('https://aisandbox-pa.googleapis.com/v1/image:generate', {
              method: 'POST',
              headers: {
                'Authorization': 'Bearer ${token}',
                'Content-Type': 'text/plain;charset=UTF-8',
                'Origin': 'https://labs.google',
                'Referer': 'https://labs.google/'
              },
              body: JSON.stringify({
                prompt: 'a beautiful sunset',
                model: 'imagen_3'
              })
            }).then(async r => {
              const t = await r.text();
              return JSON.stringify({ status: r.status, body: t.substring(0, 500) });
            })
          `);
        }
      },
      {
        name: 'Check labs.google ImageFX tRPC',
        test: async () => {
          return await evaluate(cdp, `
            fetch('https://labs.google/fx/api/trpc/media.listToolMedia?input=' + encodeURIComponent(JSON.stringify({
              json: { toolName: 'IMAGEFX', limit: 5 }
            })), {
              headers: { 'Content-Type': 'application/json' }
            }).then(async r => {
              const t = await r.text();
              return JSON.stringify({ status: r.status, body: t.substring(0, 500) });
            })
          `);
        }
      },
      {
        name: 'Check labs.google Flow tRPC - list tools',
        test: async () => {
          return await evaluate(cdp, `
            fetch('https://labs.google/fx/api/trpc/general.listTools', {
              headers: { 'Content-Type': 'application/json' }
            }).then(async r => {
              const t = await r.text();
              return JSON.stringify({ status: r.status, body: t.substring(0, 800) });
            })
          `);
        }
      },
      {
        name: 'Check captured network requests',
        test: async () => {
          return await evaluate(cdp, `JSON.stringify(window.__capturedFetches || [])`);
        }
      }
    ];

    for (const ep of imageEndpoints) {
      log(`\n--- ${ep.name} ---`);
      try {
        const result = await ep.test();
        const parsed = JSON.parse(result);
        if (parsed.status) {
          log(`  Status: ${parsed.status}`);
          log(`  Body: ${typeof parsed.body === 'string' ? parsed.body.substring(0, 300) : JSON.stringify(parsed.body).substring(0, 300)}`);
        } else {
          log(`  Result: ${JSON.stringify(parsed).substring(0, 500)}`);
        }
      } catch (e) {
        log(`  ERROR: ${e.message}`);
      }
      await sleep(1000);
    }

    // Step 7: Navigate to ImageFX page to discover endpoints
    log('\n=== STEP 7: Check if ImageFX exists at labs.google ===');
    const imageFxCheck = await evaluate(cdp, `
      fetch('https://labs.google/fx/tools/image-fx/', {
        method: 'HEAD',
        redirect: 'follow'
      }).then(r => JSON.stringify({ status: r.status, url: r.url, redirected: r.redirected }))
    `);
    log(`ImageFX page: ${imageFxCheck}`);

  } finally {
    cdp.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
