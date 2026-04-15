/**
 * DEFINITIVE settings test v2:
 * - Settings button detection: aria-haspopup="menu" button near bottom with crop_ text
 * - After mode change, button text changes — re-detect by position & aria-haspopup
 */
const WebSocket = require('ws');
const http = require('http');

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

// Find the settings button — flexible detection
// It's the button with aria-haspopup="menu" that contains "crop_" and is near the prompt area
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

// Open dropdown and get items
async function openAndGetTabs(ws) {
  const btnStr = await findSettingsButton(ws);
  if (!btnStr) { console.log('  Settings button not found'); return null; }
  const btn = JSON.parse(btnStr);
  console.log(`  Settings: "${btn.text}" at (${btn.x}, ${btn.y})`);
  await cdpClick(ws, btn.x, btn.y);
  await sleep(1500);

  const tabsStr = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper] [role="tab"], [data-radix-popper-content-wrapper] button'))
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            text: (el.textContent?.trim() || '').substring(0, 60),
            state: el.getAttribute('data-state') || '',
            selected: el.getAttribute('aria-selected') || '',
            x: Math.round(r.x + r.width/2),
            y: Math.round(r.y + r.height/2)
          };
        })
    )
  `);
  return JSON.parse(tabsStr);
}

async function closeDropdown(ws) {
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
}

async function main() {
  const pages = await getPages();
  let flowPage = pages.find(p => p.url.includes('flow/project'));
  if (!flowPage) { console.error('No Flow page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  let url = await evalJS(ws, 'window.location.href');

  if (url.includes('/edit/')) {
    await sendCDP(ws, 'Page.navigate', { url: url.split('/edit/')[0] });
    await sleep(5000);
  }
  try { await sendCDP(ws, 'Page.bringToFront'); } catch(e) {}
  await sleep(500);

  // ===== Step 1: Read current state =====
  console.log('\n=== STEP 1: Current Settings ===');
  let tabs = await openAndGetTabs(ws);
  if (!tabs) { ws.close(); return; }
  tabs.forEach(t => {
    const mark = t.state === 'active' || t.selected === 'true' ? ' <<<' : '';
    console.log(`  [${t.state}] "${t.text}" at (${t.x},${t.y})${mark}`);
  });
  await closeDropdown(ws);

  // ===== Step 2: Set Video + Landscape + x2 =====
  console.log('\n=== STEP 2: Apply Video + Landscape + x2 ===');

  // Click Video
  console.log('  Setting Video...');
  tabs = await openAndGetTabs(ws);
  if (tabs) {
    const videoTab = tabs.find(t => t.text.includes('Video'));
    if (videoTab) {
      if (videoTab.state === 'active') {
        console.log('    Already Video');
      } else {
        await cdpClick(ws, videoTab.x, videoTab.y);
        console.log('    Clicked Video');
        await sleep(1000);
      }
    }
  }
  await closeDropdown(ws);

  // Read new button text
  let newBtn = await findSettingsButton(ws);
  console.log(`  Button now: ${newBtn}`);

  // Click Landscape
  console.log('  Setting Landscape...');
  tabs = await openAndGetTabs(ws);
  if (tabs) {
    const lsTab = tabs.find(t => t.text.includes('Landscape'));
    if (lsTab) {
      if (lsTab.state === 'active') {
        console.log('    Already Landscape');
      } else {
        await cdpClick(ws, lsTab.x, lsTab.y);
        console.log('    Clicked Landscape');
        await sleep(1000);
      }
    }
  }
  await closeDropdown(ws);

  // Click x2
  console.log('  Setting x2...');
  tabs = await openAndGetTabs(ws);
  if (tabs) {
    const x2Tab = tabs.find(t => t.text === 'x2');
    if (x2Tab) {
      if (x2Tab.state === 'active') {
        console.log('    Already x2');
      } else {
        await cdpClick(ws, x2Tab.x, x2Tab.y);
        console.log('    Clicked x2');
        await sleep(1000);
      }
    }
  }
  await closeDropdown(ws);

  // ===== Step 3: Verify final state =====
  console.log('\n=== STEP 3: Verify final state ===');
  tabs = await openAndGetTabs(ws);
  if (tabs) {
    tabs.forEach(t => {
      const mark = t.state === 'active' || t.selected === 'true' ? ' <<<' : '';
      console.log(`  [${t.state}] "${t.text}"${mark}`);
    });
  }
  await closeDropdown(ws);

  // ===== Step 4: Test model sub-dropdown =====
  console.log('\n=== STEP 4: Model sub-dropdown ===');
  tabs = await openAndGetTabs(ws);
  if (tabs) {
    const modelBtn = tabs.find(t => t.text.includes('arrow_drop_down'));
    if (modelBtn) {
      console.log(`  Model button: "${modelBtn.text}" at (${modelBtn.x}, ${modelBtn.y})`);
      await cdpClick(ws, modelBtn.x, modelBtn.y);
      await sleep(2000);

      // Take screenshot of model dropdown
      const ss = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync('c:/Users/Admin/Desktop/veo3/scripts/model-dropdown.png', Buffer.from(ss.data, 'base64'));
      console.log('  Screenshot: scripts/model-dropdown.png');

      // Find model options — could be menuitem, option, or something else
      const modelOptions = await evalJS(ws, `
        JSON.stringify((function(){
          // Get all radix popper contents
          const poppers = document.querySelectorAll('[data-radix-popper-content-wrapper]');
          const allItems = [];
          poppers.forEach(popper => {
            const items = popper.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"]');
            items.forEach(el => {
              if (el.getBoundingClientRect().width === 0) return;
              const r = el.getBoundingClientRect();
              allItems.push({
                text: (el.textContent?.trim() || '').substring(0, 60),
                role: el.getAttribute('role') || el.tagName,
                state: el.getAttribute('data-state') || '',
                x: Math.round(r.x + r.width/2),
                y: Math.round(r.y + r.height/2)
              });
            });
          });
          return allItems;
        })())
      `);
      const opts = JSON.parse(modelOptions);
      console.log(`  All popper items (${opts.length}):`);
      opts.forEach(o => console.log(`    [${o.state}] ${o.role}: "${o.text}" at (${o.x}, ${o.y})`));
    }
  }

  // Close all
  await closeDropdown(ws);
  await closeDropdown(ws);

  ws.close();
  console.log('\nDone');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
