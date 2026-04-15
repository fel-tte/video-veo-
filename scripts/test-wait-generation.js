/**
 * Submit prompt and properly wait for generation
 * The editor clears after submit = prompt was accepted
 * Now we need to wait for the media to appear (could take 1-5 minutes)
 */
const WebSocket = require('ws');
const http = require('http');

const CDP_PORT = 9222;
const PROMPT = 'A fluffy white cat walking through cherry blossoms, slow motion, cinematic';

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

  // Count existing media
  const initialCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  log(`Initial media count: ${initialCount}`);

  // Check if there's already a generating item (from previous submit)
  const existingStatus = await evalJS(ws, `
    JSON.stringify((function(){
      const items = document.querySelectorAll('[id^="fe_id_"]');
      let generating = 0;
      let completed = 0;
      items.forEach(item => {
        // Check for loading/progress indicators inside the item
        const hasProgress = item.querySelector('[class*="progress"], [class*="loading"], [role="progressbar"]') !== null;
        const hasVideo = item.querySelector('video') !== null;
        const hasImage = item.querySelector('img:not([src*="gstatic"])') !== null;
        if (hasProgress) generating++;
        else if (hasVideo || hasImage) completed++;
      });
      return { total: items.length, generating, completed };
    })())
  `);
  log(`Existing items: ${existingStatus}`);

  // Click editor, type, submit
  log('Clicking editor...');
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

  log(`Typing: "${PROMPT}"`);
  await sendCDP(ws, 'Input.insertText', { text: PROMPT });
  await sleep(1000);

  // Verify typed
  const typed = await evalJS(ws, `document.querySelector("div[contenteditable='true']")?.textContent`);
  log(`Editor content: "${typed?.substring(0, 60)}"`);

  // Find and click Create
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
  log(`Clicking Create at (${cp.x}, ${cp.y})...`);
  await cdpClick(ws, cp.x, cp.y);
  await sleep(3000);

  // Verify submission: editor should be cleared
  const afterSubmit = await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return 'editor gone';
      const placeholder = ce.querySelector('[data-slate-placeholder]');
      return placeholder ? 'SUBMITTED (placeholder visible)' : 'text: ' + ce.textContent?.substring(0, 60);
    })()
  `);
  log(`After Create: ${afterSubmit}`);

  if (!afterSubmit.includes('SUBMITTED')) {
    log('Create did NOT submit. Prompt still in editor.');
    ws.close(); return;
  }

  // Now wait for generation
  log('Waiting for new media to appear (poll every 10s, max 8 min)...');
  const startTime = Date.now();
  const maxWait = 8 * 60 * 1000;

  while (Date.now() - startTime < maxWait) {
    await sleep(10000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    const status = await evalJS(ws, `
      JSON.stringify((function(){
        const items = document.querySelectorAll('[id^="fe_id_"]');
        const ids = Array.from(items).map(i => i.id.substring(0, 25));
        let hasLoading = false;
        let hasNewVideo = false;
        items.forEach(item => {
          const loading = item.querySelector('[class*="progress"], [class*="loading"], [role="progressbar"], .MuiCircularProgress-root, [class*="spinner"]');
          if (loading && loading.getBoundingClientRect().width > 0) hasLoading = true;
          const vid = item.querySelector('video');
          if (vid && vid.src && !vid.src.includes('gstatic')) hasNewVideo = true;
        });
        // Also check for any snackbar/notification about generation
        const notifications = Array.from(document.querySelectorAll('[class*="snackbar"], [class*="toast"], [role="status"]'))
          .filter(el => el.getBoundingClientRect().width > 0)
          .map(el => el.textContent?.trim()?.substring(0, 80));
        return {
          count: items.length,
          ids: ids.slice(-3),
          hasLoading,
          hasNewVideo,
          notifications
        };
      })())
    `);
    const s = JSON.parse(status);
    log(`[${elapsed}s] items=${s.count}/${initialCount} loading=${s.hasLoading} newVid=${s.hasNewVideo} notif=${JSON.stringify(s.notifications)}`);

    if (s.count > initialCount) {
      log(`New items appeared! Count: ${s.count} (was ${initialCount})`);

      // Check if still loading
      if (s.hasLoading) {
        log('Still generating... waiting more');
        continue;
      }

      log('=== GENERATION COMPLETE ===');

      // Open latest item
      const openResult = await evalJS(ws, `
        (function(){
          const items = document.querySelectorAll('[id^="fe_id_"]');
          const last = items[items.length - 1];
          const link = last.querySelector('a');
          if (link) { link.click(); return 'OK: ' + link.href; }
          last.click();
          return 'OK: clicked item';
        })()
      `);
      log(`Opened: ${openResult}`);
      await sleep(5000);

      // Extract video URL
      const videoSrc = await evalJS(ws, `
        (function(){
          const videos = document.querySelectorAll('video');
          const real = Array.from(videos).filter(v => {
            const src = v.src || v.currentSrc || '';
            return src && !src.includes('gstatic.com');
          });
          return real.length > 0 ? (real[real.length-1].src || real[real.length-1].currentSrc) : '';
        })()
      `);
      log(`Video URL: ${videoSrc ? videoSrc.substring(0, 100) : 'NOT FOUND'}`);

      // Download button
      const dlBtn = await evalJS(ws, `
        (function(){
          const btns = document.querySelectorAll('button');
          for (const b of btns) {
            if (b.textContent?.includes('Download') && b.getBoundingClientRect().width > 0) return 'FOUND';
          }
          return 'NOT FOUND';
        })()
      `);
      log(`Download button: ${dlBtn}`);

      // Download video
      if (videoSrc) {
        try {
          const videoData = await evalJS(ws, `
            (async function(){
              const resp = await fetch(${JSON.stringify(videoSrc)});
              if (!resp.ok) return 'FAIL:' + resp.status;
              const blob = await resp.blob();
              const reader = new FileReader();
              return new Promise(resolve => {
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
              });
            })()
          `);
          if (videoData?.startsWith('data:')) {
            const buffer = Buffer.from(videoData.split(',')[1], 'base64');
            const fs = require('fs');
            const path = require('path');
            const dir = path.join(require('os').homedir(), 'Videos', 'Veo3');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `test_${Date.now()}.mp4`);
            fs.writeFileSync(file, buffer);
            log(`DOWNLOADED: ${file} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
          }
        } catch (e) {
          log(`Download error: ${e.message}`);
        }
      }

      break;
    }
  }

  if (Date.now() - startTime >= maxWait) {
    log('TIMEOUT: Generation did not complete in 8 minutes');
  }

  ws.close();
  log('Done');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
