/**
 * DEFINITIVE Full E2E Flow Test v2
 * Validated selectors:
 *   - Settings button: button[aria-haspopup="menu"] containing "crop_"
 *   - Settings tabs: role="tab" with data-state="active"/"inactive"
 *   - Model sub-dropdown: role="menuitem" items
 *   - Prompt input: div[contenteditable='true']
 *   - Submit: button containing "Create" + "arrow_forward"
 *   - Media items: [id^="fe_id_"]
 *   - Video URL: filter out gstatic camera previews
 *   - Download button: button containing "Download"
 */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const TEST_PROMPT = 'A golden retriever puppy playing in autumn leaves, cinematic slow motion, warm sunset lighting';
const DOWNLOAD_DIR = path.join(require('os').homedir(), 'Videos', 'Veo3');

// ===== CDP Helpers =====
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
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(100);
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(50);
  await sendCDP(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function pressEscape(ws) {
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(step, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] STEP ${step}: ${msg}`);
}

// ===== Settings Helpers =====

async function findSettingsButton(ws) {
  return await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button[aria-haspopup="menu"]');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('crop_') && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({ text: t.substring(0,80), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
        }
      }
      return null;
    })()
  `);
}

async function openSettingsDropdown(ws) {
  const btnStr = await findSettingsButton(ws);
  if (!btnStr) return false;
  const btn = JSON.parse(btnStr);
  await cdpClick(ws, btn.x, btn.y);
  await sleep(1500);
  return true;
}

async function getSettingsTabs(ws) {
  const tabsStr = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper] [role="tab"], [data-radix-popper-content-wrapper] button'))
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            text: (el.textContent?.trim() || '').substring(0, 80),
            state: el.getAttribute('data-state') || '',
            selected: el.getAttribute('aria-selected') || '',
            role: el.getAttribute('role') || 'button',
            x: Math.round(r.x + r.width/2),
            y: Math.round(r.y + r.height/2)
          };
        })
    )
  `);
  return JSON.parse(tabsStr);
}

async function clickSettingsTab(ws, searchText) {
  if (!(await openSettingsDropdown(ws))) return false;
  const tabs = await getSettingsTabs(ws);
  const tab = tabs.find(t => t.text.includes(searchText));
  if (!tab) { await pressEscape(ws); return false; }
  if (tab.state === 'active' || tab.selected === 'true') {
    await pressEscape(ws);
    return true; // already active
  }
  await cdpClick(ws, tab.x, tab.y);
  await sleep(800);
  await pressEscape(ws);
  await sleep(500);
  return true;
}

async function clickModelMenuItem(ws, modelText) {
  if (!(await openSettingsDropdown(ws))) return false;
  const tabs = await getSettingsTabs(ws);
  const modelBtn = tabs.find(t => t.text.includes('arrow_drop_down'));
  if (!modelBtn) { await pressEscape(ws); return false; }
  await cdpClick(ws, modelBtn.x, modelBtn.y);
  await sleep(1500);

  // Get menuitem items
  const items = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('[role="menuitem"]'))
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => {
          const r = el.getBoundingClientRect();
          return { text: (el.textContent?.trim()||'').substring(0,60), x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) };
        })
    )
  `);
  const menuItems = JSON.parse(items);
  const target = menuItems.find(i => i.text.includes(modelText));
  if (!target) { await pressEscape(ws); await pressEscape(ws); return false; }
  await cdpClick(ws, target.x, target.y);
  await sleep(800);
  await pressEscape(ws);
  await sleep(500);
  return true;
}

// ===== Main Test =====

async function main() {
  const results = {};

  // ===== 1. Connect to Flow page =====
  log(1, 'Finding Flow project page...');
  const pages = await getPages();
  let flowPage = pages.find(p => p.url.includes('flow/project') && !p.url.includes('/edit/'));
  if (!flowPage) flowPage = pages.find(p => p.url.includes('flow/project'));
  if (!flowPage) flowPage = pages.find(p => p.url.includes('flow'));
  if (!flowPage) { console.error('FAIL: No Flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  let url = await evalJS(ws, 'window.location.href');

  // Navigate to project page if on edit
  if (url.includes('/edit/')) {
    const projectUrl = url.split('/edit/')[0];
    log(1, `On edit page, navigating to project: ${projectUrl}`);
    await sendCDP(ws, 'Page.navigate', { url: projectUrl });
    await sleep(5000);
    url = await evalJS(ws, 'window.location.href');
  }
  log(1, `Connected: ${url}`);
  try { await sendCDP(ws, 'Page.bringToFront'); } catch(e) {}
  results.navigate = 'OK';

  // ===== 2. Check login =====
  log(2, 'Checking login...');
  const loginOk = await evalJS(ws, `!!document.querySelector("div[contenteditable='true']") || document.body.innerText.includes('What do you want to create')`);
  log(2, loginOk ? 'OK: logged in' : 'FAIL: not logged in');
  if (!loginOk) { ws.close(); process.exit(1); }
  results.login = 'OK';

  // ===== 3. Apply settings: Video mode =====
  log(3, 'Setting Video mode...');
  const videoOk = await clickSettingsTab(ws, 'Video');
  log(3, videoOk ? 'OK' : 'SKIP');
  results.set_video = videoOk ? 'OK' : 'SKIP';

  // ===== 4. Apply settings: Landscape =====
  log(4, 'Setting Landscape...');
  const lsOk = await clickSettingsTab(ws, 'Landscape');
  log(4, lsOk ? 'OK' : 'SKIP');
  results.set_landscape = lsOk ? 'OK' : 'SKIP';

  // ===== 5. Apply settings: x2 =====
  log(5, 'Setting x2 output...');
  const x2Ok = await clickSettingsTab(ws, 'x2');
  log(5, x2Ok ? 'OK' : 'SKIP');
  results.set_x2 = x2Ok ? 'OK' : 'SKIP';

  // ===== 6. Set model: Veo 3.1 - Fast =====
  log(6, 'Setting model Veo 3.1 - Fast...');
  const modelOk = await clickModelMenuItem(ws, 'Veo 3.1 - Fast');
  log(6, modelOk ? 'OK' : 'SKIP');
  results.set_model = modelOk ? 'OK' : 'SKIP';

  // ===== 7. Read final settings state =====
  log(7, 'Reading final settings...');
  const finalBtn = await findSettingsButton(ws);
  if (finalBtn) {
    log(7, `Settings button: ${finalBtn}`);
    results.final_settings = JSON.parse(finalBtn).text;
  }

  // ===== 8. Count existing media =====
  log(8, 'Counting existing media...');
  const initialCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  log(8, `Initial count: ${initialCount}`);

  // ===== 9. Type prompt =====
  log(9, `Typing prompt: "${TEST_PROMPT.substring(0, 50)}..."`);
  const typeOk = await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return false;
      ce.click(); ce.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ce);
      sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('insertText', false, ${JSON.stringify(TEST_PROMPT)});
      return ce.textContent.length > 0;
    })()
  `);
  log(9, typeOk ? 'OK' : 'FAIL');
  results.prompt = typeOk ? 'OK' : 'FAIL';
  await sleep(1000);

  // ===== 10. Click Create =====
  log(10, 'Finding Create button...');
  const submitPos = await evalJS(ws, `
    (function(){
      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        // On project page: "arrow_forward Create" near prompt area
        if (text.includes('Create') && text.includes('arrow_forward') && btn.getBoundingClientRect().width > 0) {
          const r = btn.getBoundingClientRect();
          // Pick the one closest to bottom (near prompt input area, y > 700)
          if (r.y > 650) {
            return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: text.substring(0,40) });
          }
        }
      }
      // Fallback: any Create button
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        if (text.includes('Create') && text.includes('arrow_forward') && btn.getBoundingClientRect().width > 0) {
          const r = btn.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: text.substring(0,40) });
        }
      }
      return null;
    })()
  `);

  if (!submitPos) {
    log(10, 'FAIL: Create button not found');
    results.submit = 'FAIL';
    printResults(results);
    ws.close(); return;
  }

  const sub = JSON.parse(submitPos);
  log(10, `Clicking Create at (${sub.x}, ${sub.y})`);
  await cdpClick(ws, sub.x, sub.y);
  await sleep(2000);
  results.submit = 'OK';

  // ===== 11. Wait for generation =====
  log(11, 'Waiting for generation (max 8 min, poll every 15s)...');
  const startTime = Date.now();
  const maxWait = 8 * 60 * 1000;
  let generated = false;

  while (Date.now() - startTime < maxWait) {
    await sleep(15000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    const status = await evalJS(ws, `
      JSON.stringify((function(){
        const count = document.querySelectorAll('[id^="fe_id_"]').length;
        // Check for loading/generating indicators
        const spinners = document.querySelectorAll('[class*="loading"], [class*="spinner"], [class*="progress"]');
        const generating = Array.from(spinners).some(el => el.getBoundingClientRect().width > 0);
        // Check for errors
        let error = '';
        document.querySelectorAll('[role="alert"]').forEach(el => {
          const t = el.textContent?.trim();
          if (t && t.length > 5) error = t.substring(0, 150);
        });
        return { count, generating, error };
      })())
    `);
    const s = JSON.parse(status);
    log(11, `[${elapsed}s] media=${s.count}/${initialCount} generating=${s.generating} error=${s.error || 'none'}`);

    if (s.error) {
      log(11, `GENERATION ERROR: ${s.error}`);
      results.generation = 'ERROR: ' + s.error;
      break;
    }

    // New media appeared = generation complete
    if (s.count > initialCount) {
      log(11, `Generation complete! New items: ${s.count - initialCount}`);
      generated = true;
      results.generation = `OK: +${s.count - initialCount} items`;
      break;
    }
  }

  if (!generated && !results.generation) {
    results.generation = 'TIMEOUT';
    log(11, 'Generation timed out after 8 min');
  }

  if (!generated) {
    printResults(results);
    ws.close(); return;
  }

  await sleep(3000);

  // ===== 12. Open latest media detail =====
  log(12, 'Opening latest media detail...');
  const mediaClick = await evalJS(ws, `
    (function(){
      const items = document.querySelectorAll('[id^="fe_id_"]');
      if (items.length === 0) return 'FAIL: no items';
      const last = items[items.length - 1];
      const link = last.querySelector('a');
      if (link) { link.click(); return 'OK: ' + link.href; }
      last.click();
      return 'OK: clicked item';
    })()
  `);
  log(12, mediaClick);
  results.open_detail = mediaClick.startsWith('OK') ? 'OK' : 'FAIL';
  await sleep(5000);

  // ===== 13. Extract video URL =====
  log(13, 'Extracting video source...');
  // Try multiple times (video may load async)
  let videoSrc = '';
  for (let i = 0; i < 5; i++) {
    videoSrc = await evalJS(ws, `
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
    if (videoSrc) break;
    log(13, `Waiting for video element... attempt ${i + 1}/5`);
    await sleep(3000);
  }

  if (videoSrc) {
    log(13, `Video URL: ${videoSrc.substring(0, 120)}`);
    results.video_url = 'OK';
  } else {
    log(13, 'No video URL found');
    results.video_url = 'FAIL';
  }

  // ===== 14. Download video =====
  if (videoSrc) {
    log(14, 'Downloading video...');
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
        const base64 = videoData.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');
        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
        const slug = TEST_PROMPT.substring(0, 40).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
        const filename = `${slug}_${Date.now()}.mp4`;
        const fullPath = path.join(DOWNLOAD_DIR, filename);
        fs.writeFileSync(fullPath, buffer);
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
        log(14, `SAVED: ${fullPath} (${sizeMB} MB)`);
        results.download = `OK: ${sizeMB} MB`;
        results.file_path = fullPath;
      } else {
        results.download = 'FAIL: ' + String(videoData).substring(0, 100);
      }
    } catch (e) {
      log(14, `Download error: ${e.message}`);
      results.download = 'FAIL: ' + e.message;
    }
  } else {
    results.download = 'SKIP: no video URL';
  }

  // ===== 15. Check Download button =====
  log(15, 'Checking Download button...');
  const dlBtn = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('Download') && b.getBoundingClientRect().width > 0) {
          return JSON.stringify({ text: t.substring(0,40), x: Math.round(b.getBoundingClientRect().x + b.getBoundingClientRect().width/2), y: Math.round(b.getBoundingClientRect().y + b.getBoundingClientRect().height/2) });
        }
      }
      return null;
    })()
  `);
  results.download_btn = dlBtn ? 'OK' : 'FAIL';
  if (dlBtn) log(15, `Download button: ${dlBtn}`);
  else log(15, 'Download button not found');

  // ===== FINAL REPORT =====
  printResults(results);
  ws.close();
}

function printResults(results) {
  console.log('\n' + '='.repeat(60));
  console.log('FULL FLOW TEST v2 — RESULTS');
  console.log('='.repeat(60));
  Object.entries(results).forEach(([k, v]) => {
    const s = String(v);
    const icon = s.startsWith('OK') ? '[OK]' : s.startsWith('SKIP') ? '[--]' : '[!!]';
    console.log(`  ${icon} ${k}: ${s}`);
  });
  console.log('='.repeat(60));
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
