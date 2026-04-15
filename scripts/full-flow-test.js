/**
 * Full E2E Flow Test — test everything via CDP before putting in Go
 * Steps: navigate → login check → open settings → apply settings → type prompt → submit → wait → extract video → download
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const TEST_PROMPT = 'A cat sitting on a windowsill watching rain fall outside, cozy warm lighting, lo-fi aesthetic';
const DOWNLOAD_DIR = path.join(require('os').homedir(), 'Videos', 'Veo3');

// ============ CDP Helpers ============

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

async function cdpClick(ws, x, y) {
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(step, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] STEP ${step}: ${msg}`);
}

// ============ Test Steps ============

async function main() {
  const results = {};

  // ===== 1. Find and connect to Flow project page =====
  log(1, 'Finding Flow project page...');
  const pages = await getPages();

  // Prefer project page (not edit page)
  let flowPage = pages.find(p => p.url.includes('flow/project') && !p.url.includes('/edit/'));
  if (!flowPage) {
    // Check edit page, navigate back
    flowPage = pages.find(p => p.url.includes('flow/project'));
  }
  if (!flowPage) {
    flowPage = pages.find(p => p.url.includes('flow'));
  }
  if (!flowPage) {
    console.error('FAIL: No Flow page found');
    process.exit(1);
  }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  let url = await evalJS(ws, 'window.location.href');
  log(1, `Connected: ${url}`);

  // If on edit page, go back to project
  if (url.includes('/edit/')) {
    const projectUrl = url.split('/edit/')[0];
    log(1, `On edit page, navigating to project: ${projectUrl}`);
    await sendCDP(ws, 'Page.navigate', { url: projectUrl });
    await sleep(5000);
    url = await evalJS(ws, 'window.location.href');
  }
  results.navigate = 'OK';

  // ===== 2. Check login =====
  log(2, 'Checking login...');
  const loginCheck = await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (ce) return 'OK: prompt input found';
      if (document.body.innerText.includes('What do you want to create')) return 'OK: create text';
      return 'FAIL: not logged in';
    })()
  `);
  log(2, loginCheck);
  if (loginCheck.startsWith('FAIL')) {
    console.error('Not logged in. Login manually first.');
    ws.close(); process.exit(1);
  }
  results.login = 'OK';

  // ===== 3. Open settings dropdown (CDP click required) =====
  log(3, 'Opening settings dropdown...');
  const settingsPos = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_') && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({text: t.substring(0,60), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
        }
      }
      return null;
    })()
  `);

  if (settingsPos) {
    const sp = JSON.parse(settingsPos);
    log(3, `Settings button: "${sp.text}" at (${sp.x}, ${sp.y})`);
    await cdpClick(ws, sp.x, sp.y);
    await sleep(2000);

    // Read current menu state
    const menuItems = await evalJS(ws, `
      JSON.stringify(
        Array.from(document.querySelectorAll('[role="menuitem"]'))
          .filter(el => el.getBoundingClientRect().width > 0)
          .map(el => ({
            text: el.textContent?.trim()?.substring(0, 60),
            state: el.getAttribute('data-state') || '',
            x: Math.round(el.getBoundingClientRect().x + el.getBoundingClientRect().width/2),
            y: Math.round(el.getBoundingClientRect().y + el.getBoundingClientRect().height/2)
          }))
      )
    `);
    const items = JSON.parse(menuItems || '[]');
    log(3, `Menu items: ${items.map(i => `${i.state === 'active' ? '[X]' : '[ ]'} ${i.text}`).join(', ')}`);
    results.settings_menu = items;

    // ===== 4. Select "Video" mode if not active =====
    log(4, 'Ensuring Video mode...');
    const videoItem = items.find(i => i.text.includes('Video'));
    if (videoItem && videoItem.state !== 'active') {
      log(4, `Clicking Video at (${videoItem.x}, ${videoItem.y})`);
      await cdpClick(ws, videoItem.x, videoItem.y);
      await sleep(1000);
    } else if (videoItem) {
      log(4, 'Video already active');
    } else {
      log(4, 'Video menu item not found');
    }
    results.video_mode = videoItem ? 'OK' : 'NOT_FOUND';

    // ===== 5. Select Landscape =====
    log(5, 'Ensuring Landscape...');
    const landscapeItem = items.find(i => i.text.includes('Landscape'));
    if (landscapeItem && landscapeItem.state !== 'active') {
      await cdpClick(ws, landscapeItem.x, landscapeItem.y);
      await sleep(500);
    } else {
      log(5, 'Landscape already active or not found');
    }

    // ===== 6. Select x2 =====
    log(6, 'Ensuring x2 output...');
    const x2Item = items.find(i => i.text === 'x2');
    if (x2Item && x2Item.state !== 'active') {
      await cdpClick(ws, x2Item.x, x2Item.y);
      await sleep(500);
    } else {
      log(6, 'x2 already active or not found');
    }

    // Close dropdown
    await evalJS(ws, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(1000);
    results.settings = 'OK';
  } else {
    log(3, 'Settings button not found, skipping');
    results.settings = 'SKIP';
  }

  // ===== 7. Count existing media items =====
  log(7, 'Counting existing media...');
  const initialCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  log(7, `Initial media count: ${initialCount}`);

  // ===== 8. Type prompt =====
  log(8, 'Typing prompt...');
  const typeResult = await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return 'FAIL: no contenteditable';
      ce.click(); ce.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ce);
      sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('insertText', false, ${JSON.stringify(TEST_PROMPT)});
      return 'OK: ' + ce.textContent.length + ' chars';
    })()
  `);
  log(8, typeResult);
  results.prompt = typeResult.startsWith('OK') ? 'OK' : 'FAIL';
  await sleep(1000);

  // ===== 9. Click Create (arrow_forward) =====
  log(9, 'Finding submit button...');
  const submitPos = await evalJS(ws, `
    (function(){
      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        if (text.includes('Create') && text.includes('arrow_forward') && btn.getBoundingClientRect().width > 0) {
          const r = btn.getBoundingClientRect();
          return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: text.substring(0,40)});
        }
      }
      return null;
    })()
  `);

  if (!submitPos) {
    log(9, 'FAIL: Submit button not found');
    results.submit = 'FAIL';
    printResults(results);
    ws.close(); return;
  }

  const sub = JSON.parse(submitPos);
  log(9, `Clicking Create at (${sub.x}, ${sub.y})`);
  await cdpClick(ws, sub.x, sub.y);
  results.submit = 'OK';
  log(9, 'Create clicked! Generation started.');

  // ===== 10. Wait for generation =====
  log(10, 'Waiting for generation (max 5 min, polling every 10s)...');
  const startTime = Date.now();
  const maxWait = 5 * 60 * 1000;
  let generated = false;

  while (Date.now() - startTime < maxWait) {
    await sleep(10000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    const status = await evalJS(ws, `
      JSON.stringify((function(){
        // Check for video
        let hasVideo = false;
        document.querySelectorAll('video').forEach(v => {
          if ((v.src || v.currentSrc) && !(v.src || v.currentSrc).includes('gstatic')) hasVideo = true;
        });
        // Count media
        const count = document.querySelectorAll('[id^="fe_id_"]').length;
        // Check error
        let error = '';
        document.querySelectorAll('[class*="error"], [role="alert"]').forEach(el => {
          const t = el.textContent?.trim();
          if (t && t.length > 5 && !t.includes('recaptcha') && !t.includes("doesn't seem")) error = t.substring(0, 150);
        });
        return { hasVideo, count, error };
      })())
    `);
    const s = JSON.parse(status);
    log(10, `[${elapsed}s] video=${s.hasVideo}, media=${s.count}/${initialCount}, error=${s.error || 'none'}`);

    if (s.error) {
      log(10, `GENERATION ERROR: ${s.error}`);
      results.generation = 'ERROR: ' + s.error;
      break;
    }
    if (s.hasVideo || s.count > initialCount) {
      log(10, 'Generation complete!');
      generated = true;
      results.generation = 'OK';
      break;
    }
  }

  if (!generated && !results.generation) {
    results.generation = 'TIMEOUT';
    log(10, 'Generation timed out');
    printResults(results);
    ws.close(); return;
  }
  if (!generated) {
    printResults(results);
    ws.close(); return;
  }

  await sleep(3000);

  // ===== 11. Open last media detail =====
  log(11, 'Opening latest media detail...');
  const mediaClick = await evalJS(ws, `
    (function(){
      const items = document.querySelectorAll('[id^="fe_id_"]');
      if (items.length === 0) return 'FAIL: no items';
      const last = items[items.length - 1];
      const link = last.querySelector('a');
      if (link) { link.click(); return 'OK: ' + link.href; }
      last.click();
      return 'OK: clicked directly';
    })()
  `);
  log(11, mediaClick);
  results.open_detail = mediaClick.startsWith('OK') ? 'OK' : 'FAIL';
  await sleep(5000);

  // ===== 12. Extract video URL =====
  log(12, 'Extracting video source...');
  const videoSrc = await evalJS(ws, `
    (function(){
      const videos = document.querySelectorAll('video');
      const real = Array.from(videos).filter(v => {
        const src = v.src || v.currentSrc || '';
        return src && !src.includes('gstatic.com');
      });
      if (real.length === 0) return '';
      return real[real.length - 1].src || real[real.length - 1].currentSrc || '';
    })()
  `);
  log(12, `Video URL: ${videoSrc.substring(0, 120)}...`);
  results.video_url = videoSrc ? 'OK' : 'FAIL';

  // ===== 13. Download video via fetch =====
  if (videoSrc && !videoSrc.startsWith('blob:')) {
    log(13, 'Downloading video via fetch...');
    try {
      const videoData = await evalJS(ws, `
        (async function(){
          const resp = await fetch(${JSON.stringify(videoSrc)});
          if (!resp.ok) return 'FETCH_FAIL:' + resp.status;
          const blob = await resp.blob();
          const reader = new FileReader();
          return new Promise(resolve => {
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        })()
      `);

      if (videoData && videoData.startsWith('data:')) {
        // Extract base64
        const base64 = videoData.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');

        // Save to file
        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
        const slug = TEST_PROMPT.substring(0, 40).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
        const filename = `${slug}_${Date.now()}.mp4`;
        const fullPath = path.join(DOWNLOAD_DIR, filename);

        fs.writeFileSync(fullPath, buffer);
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
        log(13, `SAVED: ${fullPath} (${sizeMB} MB)`);
        results.download = `OK: ${sizeMB} MB`;
        results.file_path = fullPath;
      } else {
        log(13, `Fetch result: ${String(videoData).substring(0, 100)}`);
        results.download = 'FAIL: bad fetch';
      }
    } catch (e) {
      log(13, `Download error: ${e.message}`);
      results.download = 'FAIL: ' + e.message;
    }
  } else if (videoSrc && videoSrc.startsWith('blob:')) {
    log(13, 'Video is blob URL, trying blob fetch...');
    try {
      const videoData = await evalJS(ws, `
        (async function(){
          const resp = await fetch(${JSON.stringify(videoSrc)});
          const blob = await resp.blob();
          const reader = new FileReader();
          return new Promise(resolve => {
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        })()
      `);

      if (videoData && videoData.startsWith('data:')) {
        const base64 = videoData.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');
        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
        const slug = TEST_PROMPT.substring(0, 40).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
        const filename = `${slug}_${Date.now()}.mp4`;
        const fullPath = path.join(DOWNLOAD_DIR, filename);
        fs.writeFileSync(fullPath, buffer);
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
        log(13, `SAVED: ${fullPath} (${sizeMB} MB)`);
        results.download = `OK: ${sizeMB} MB`;
        results.file_path = fullPath;
      } else {
        results.download = 'FAIL: blob fetch';
      }
    } catch (e) {
      log(13, `Blob download error: ${e.message}`);
      results.download = 'FAIL: ' + e.message;
    }
  } else {
    results.download = 'SKIP: no video URL';
  }

  // ===== 14. Check Download button as fallback =====
  log(14, 'Checking Download button...');
  const dlBtn = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('Download') && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({text: t.substring(0,40), x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)});
        }
      }
      return null;
    })()
  `);
  if (dlBtn) {
    const dl = JSON.parse(dlBtn);
    log(14, `Download button found: "${dl.text}" at (${dl.x}, ${dl.y})`);
    results.download_btn = 'OK';
  } else {
    log(14, 'Download button NOT found');
    results.download_btn = 'FAIL';
  }

  // ===== FINAL REPORT =====
  printResults(results);

  ws.close();
}

function printResults(results) {
  console.log('\n' + '='.repeat(60));
  console.log('FULL FLOW TEST RESULTS');
  console.log('='.repeat(60));
  Object.entries(results).forEach(([k, v]) => {
    if (k === 'settings_menu') return; // skip raw data
    const status = String(v).startsWith('OK') ? 'PASS' : String(v).startsWith('SKIP') ? 'SKIP' : 'FAIL';
    const icon = status === 'PASS' ? '[OK]' : status === 'SKIP' ? '[--]' : '[!!]';
    console.log(`  ${icon} ${k}: ${v}`);
  });
  console.log('='.repeat(60));
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
