/**
 * DEFINITIVE settings test: open dropdown, click tab buttons, change model
 * Menu items use role="tab" with data-state="active"/"inactive"
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

// Open the settings dropdown and return all tab items
async function openSettingsAndGetTabs(ws) {
  // Find settings button
  const btnPos = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo') || t.includes('Imagen')) && t.includes('crop_') && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: t.substring(0,60) });
        }
      }
      return null;
    })()
  `);
  if (!btnPos) return null;

  const btn = JSON.parse(btnPos);
  console.log(`Settings button: "${btn.text}" at (${btn.x}, ${btn.y})`);

  // Click to open
  await cdpClick(ws, btn.x, btn.y);
  await sleep(1500);

  // Get all tab items
  const tabs = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper] [role="tab"], [data-radix-popper-content-wrapper] button'))
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            text: (el.textContent?.trim() || '').replace(/^(image|videocam|crop_16_9|crop_9_16|arrow_drop_down)/, '').trim(),
            rawText: (el.textContent?.trim() || '').substring(0, 60),
            role: el.getAttribute('role'),
            state: el.getAttribute('data-state'),
            selected: el.getAttribute('aria-selected'),
            x: Math.round(r.x + r.width/2),
            y: Math.round(r.y + r.height/2)
          };
        })
    )
  `);
  return JSON.parse(tabs);
}

async function clickTabByText(ws, tabs, searchText) {
  const tab = tabs.find(t => t.rawText.includes(searchText) || t.text.includes(searchText));
  if (!tab) {
    console.log(`  Tab "${searchText}" not found`);
    return false;
  }
  if (tab.state === 'active' || tab.selected === 'true') {
    console.log(`  "${searchText}" already active`);
    return true;
  }
  console.log(`  Clicking "${tab.rawText}" at (${tab.x}, ${tab.y})`);
  await cdpClick(ws, tab.x, tab.y);
  await sleep(800);
  return true;
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

  // ===== TEST 1: Read current settings =====
  console.log('\n=== TEST 1: Read current settings ===');
  const tabs = await openSettingsAndGetTabs(ws);
  if (!tabs) { console.error('Failed to open settings'); ws.close(); return; }

  console.log(`Found ${tabs.length} items:`);
  tabs.forEach(t => {
    const active = t.state === 'active' || t.selected === 'true' ? ' <<<' : '';
    console.log(`  [${t.state || t.role || '-'}] "${t.rawText}" at (${t.x},${t.y})${active}`);
  });

  // Close
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(1000);

  // ===== TEST 2: Switch to Video mode =====
  console.log('\n=== TEST 2: Switch to Video mode ===');
  const tabs2 = await openSettingsAndGetTabs(ws);
  if (!tabs2) { console.error('Failed to open settings'); ws.close(); return; }

  await clickTabByText(ws, tabs2, 'Video');
  await sleep(500);

  // Re-read after click (the dropdown may close or change)
  // Check if dropdown is still open
  const stillOpen = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo') || t.includes('Imagen')) && t.includes('crop_'))
          return b.getAttribute('data-state');
      }
      return 'not found';
    })()
  `);
  console.log(`  Dropdown state after click: ${stillOpen}`);

  // Read new button text
  const newBtnText = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo') || t.includes('Imagen')) && t.includes('crop_')) return t.substring(0,80);
      }
      return 'not found';
    })()
  `);
  console.log(`  New button text: "${newBtnText}"`);

  // Close if still open
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);

  // ===== TEST 3: Change aspect to Portrait =====
  console.log('\n=== TEST 3: Change to Portrait ===');
  const tabs3 = await openSettingsAndGetTabs(ws);
  if (tabs3) {
    await clickTabByText(ws, tabs3, 'Portrait');
    await sleep(500);
    const btn3 = await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t.includes('Nano') || t.includes('Veo') || t.includes('Imagen')) && t.includes('crop_')) return t.substring(0,80);
        }
        return 'not found';
      })()
    `);
    console.log(`  Button text: "${btn3}"`);
  }
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);

  // ===== TEST 4: Change output count to x4 =====
  console.log('\n=== TEST 4: Change to x4 ===');
  const tabs4 = await openSettingsAndGetTabs(ws);
  if (tabs4) {
    await clickTabByText(ws, tabs4, 'x4');
    await sleep(500);
    const btn4 = await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t.includes('Nano') || t.includes('Veo') || t.includes('Imagen')) && t.includes('crop_')) return t.substring(0,80);
        }
        return 'not found';
      })()
    `);
    console.log(`  Button text: "${btn4}"`);
  }
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);

  // ===== TEST 5: Open model sub-dropdown =====
  console.log('\n=== TEST 5: Open model sub-dropdown ===');
  const tabs5 = await openSettingsAndGetTabs(ws);
  if (tabs5) {
    // Find the model button (has arrow_drop_down)
    const modelBtn = tabs5.find(t => t.rawText.includes('arrow_drop_down'));
    if (modelBtn) {
      console.log(`  Model button: "${modelBtn.rawText}" at (${modelBtn.x}, ${modelBtn.y})`);
      await cdpClick(ws, modelBtn.x, modelBtn.y);
      await sleep(2000);

      // Check for sub-menu items
      const subItems = await evalJS(ws, `
        JSON.stringify(
          Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], [data-radix-collection-item]'))
            .filter(el => el.getBoundingClientRect().width > 0)
            .map(el => ({
              text: (el.textContent?.trim() || '').substring(0, 60),
              role: el.getAttribute('role'),
              state: el.getAttribute('data-state') || '',
              x: Math.round(el.getBoundingClientRect().x + el.getBoundingClientRect().width/2),
              y: Math.round(el.getBoundingClientRect().y + el.getBoundingClientRect().height/2)
            }))
        )
      `);
      const si = JSON.parse(subItems);
      console.log(`  Sub-menu items (${si.length}):`);
      si.forEach(i => console.log(`    [${i.state}] ${i.role}: "${i.text}" at (${i.x}, ${i.y})`));

      // If no menuitem, check for more tab-style buttons
      if (si.length === 0) {
        const moreTabs = await evalJS(ws, `
          JSON.stringify(
            Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper] button, [data-radix-popper-content-wrapper] [role="tab"]'))
              .filter(el => el.getBoundingClientRect().width > 0)
              .map(el => ({
                text: (el.textContent?.trim() || '').substring(0, 60),
                state: el.getAttribute('data-state') || '',
                selected: el.getAttribute('aria-selected') || '',
                x: Math.round(el.getBoundingClientRect().x + el.getBoundingClientRect().width/2),
                y: Math.round(el.getBoundingClientRect().y + el.getBoundingClientRect().height/2)
              }))
          )
        `);
        const mt = JSON.parse(moreTabs);
        console.log(`  All buttons in popper (${mt.length}):`);
        mt.forEach(i => console.log(`    [${i.state}] "${i.text}" at (${i.x}, ${i.y})`));
      }
    }
  }

  // Close everything
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  // ===== RESTORE: Set back to Video, Landscape, x2 =====
  console.log('\n=== RESTORE: Video, Landscape, x2 ===');
  const tabsR = await openSettingsAndGetTabs(ws);
  if (tabsR) {
    await clickTabByText(ws, tabsR, 'Video');
    await sleep(300);
    // Re-open since clicking may close
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(500);
    const tabsR2 = await openSettingsAndGetTabs(ws);
    if (tabsR2) {
      await clickTabByText(ws, tabsR2, 'Landscape');
      await sleep(300);
    }
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(500);
    const tabsR3 = await openSettingsAndGetTabs(ws);
    if (tabsR3) {
      await clickTabByText(ws, tabsR3, 'x2');
      await sleep(300);
    }
  }

  // Final state
  const finalText = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo') || t.includes('Imagen')) && t.includes('crop_')) return t.substring(0,80);
      }
      return 'not found';
    })()
  `);
  console.log(`\nFinal settings button: "${finalText}"`);

  // Close
  await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  ws.close();
  console.log('Done');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
