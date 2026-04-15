const WebSocket = require('ws');
const http = require('http');

async function getPages() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function sendCDP(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 100000);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP timeout')), 30000);
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
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return result.value;
}

async function cdpClick(ws, x, y) {
  await sendCDP(ws, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1
  });
  await sendCDP(ws, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1
  });
}

async function main() {
  const pages = await getPages();
  const flowPage = pages.find(p => p.url.includes('flow') && !p.url.includes('/edit/'));
  if (!flowPage) { console.error('No flow project page'); process.exit(1); }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  console.log('URL:', await evalJS(ws, 'window.location.href'));

  // 1. Open settings dropdown via CDP click
  console.log('\n=== Opening settings dropdown ===');
  const pos = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_') && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
        }
      }
      return null;
    })()
  `);
  if (!pos) { console.error('Settings button not found'); ws.close(); return; }

  const {x, y} = JSON.parse(pos);
  await cdpClick(ws, x, y);
  await new Promise(r => setTimeout(r, 2000));

  // 2. List all menu items
  const items = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('[role="menuitem"]'))
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            text: el.textContent?.trim()?.substring(0, 60),
            checked: el.getAttribute('data-state') || '',
            x: Math.round(r.x + r.width/2),
            y: Math.round(r.y + r.height/2)
          };
        })
    )
  `);
  console.log('Menu items:');
  const menuItems = JSON.parse(items || '[]');
  menuItems.forEach(i => console.log(`  ${i.checked === 'active' ? '[X]' : '[ ]'} ${i.text} (${i.x}, ${i.y})`));

  // 3. Try clicking "Portrait" (aspect ratio change test)
  const portrait = menuItems.find(i => i.text.includes('Portrait'));
  if (portrait) {
    console.log('\n=== Clicking Portrait ===');
    await cdpClick(ws, portrait.x, portrait.y);
    await new Promise(r => setTimeout(r, 1500));

    // Check if it changed
    const after = await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t.includes('Nano') || t.includes('Veo')) && (t.includes('crop_') || t.includes('x')) && b.getBoundingClientRect().width > 0) {
            return t.substring(0, 60);
          }
        }
        return 'not found';
      })()
    `);
    console.log('Settings button after change:', after);
  }

  // 4. Re-open dropdown and check state
  console.log('\n=== Re-opening dropdown ===');
  // Need to get new position since button text may have changed
  const pos2 = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && (t.includes('crop_') || t.includes('x')) && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
        }
      }
      return null;
    })()
  `);
  if (pos2) {
    const p2 = JSON.parse(pos2);
    await cdpClick(ws, p2.x, p2.y);
    await new Promise(r => setTimeout(r, 2000));

    const items2 = await evalJS(ws, `
      JSON.stringify(
        Array.from(document.querySelectorAll('[role="menuitem"]'))
          .filter(el => el.getBoundingClientRect().width > 0)
          .map(el => ({
            text: el.textContent?.trim()?.substring(0, 60),
            checked: el.getAttribute('data-state') || ''
          }))
      )
    `);
    console.log('Updated menu items:');
    const items2Parsed = JSON.parse(items2 || '[]');
    items2Parsed.forEach(i => console.log(`  ${i.checked === 'active' ? '[X]' : '[ ]'} ${i.text}`));

    // 5. Change back to Landscape
    const landscape = items2Parsed.find(i => i.text.includes('Landscape'));
    if (landscape) {
      console.log('\n=== Reverting to Landscape ===');
      const landscapePos = await evalJS(ws, `
        (function(){
          const items = document.querySelectorAll('[role="menuitem"]');
          for (const el of items) {
            if (el.textContent?.includes('Landscape') && el.getBoundingClientRect().width > 0) {
              const r = el.getBoundingClientRect();
              return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
            }
          }
          return null;
        })()
      `);
      if (landscapePos) {
        const lp = JSON.parse(landscapePos);
        await cdpClick(ws, lp.x, lp.y);
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // 6. Try clicking the model sub-menu (arrow_drop_down)
    console.log('\n=== Testing model sub-dropdown ===');
    // Re-open main dropdown
    const pos3 = await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t.includes('Nano') || t.includes('Veo')) && (t.includes('crop_') || t.includes('x')) && b.getBoundingClientRect().width > 0) {
            const r = b.getBoundingClientRect();
            return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
          }
        }
        return null;
      })()
    `);
    if (pos3) {
      const p3 = JSON.parse(pos3);
      await cdpClick(ws, p3.x, p3.y);
      await new Promise(r => setTimeout(r, 2000));

      // Find the model button inside dropdown
      const modelBtn = await evalJS(ws, `
        (function(){
          const items = document.querySelectorAll('[role="menuitem"], button');
          for (const el of items) {
            const t = el.textContent?.trim() || '';
            if (t.includes('arrow_drop_down') && (t.includes('Nano') || t.includes('Veo')) && el.getBoundingClientRect().width > 0) {
              const r = el.getBoundingClientRect();
              return JSON.stringify({text: t.substring(0,60), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
            }
          }
          return null;
        })()
      `);
      console.log('Model sub-button:', modelBtn);

      if (modelBtn) {
        const mb = JSON.parse(modelBtn);
        await cdpClick(ws, mb.x, mb.y);
        await new Promise(r => setTimeout(r, 2000));

        // Check for sub-menu
        const subMenu = await evalJS(ws, `
          JSON.stringify((function(){
            const results = [];
            document.querySelectorAll('[role="menuitem"], [role="option"], [role="radio"]').forEach(el => {
              if (el.getBoundingClientRect().width > 0) {
                results.push({
                  text: el.textContent?.trim()?.substring(0, 80),
                  checked: el.getAttribute('data-state') || el.getAttribute('aria-checked') || ''
                });
              }
            });
            // Also check radix popper
            document.querySelectorAll('[data-radix-popper-content-wrapper]').forEach(el => {
              if (el.getBoundingClientRect().width > 0) {
                results.push({type: 'popper', text: el.textContent?.trim()?.substring(0, 400)});
              }
            });
            return results;
          })(), null, 2)
        `);
        console.log('Sub-menu content:', subMenu);
      }
    }
  }

  // Close everything
  await evalJS(ws, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise(r => setTimeout(r, 500));
  await evalJS(ws, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  ws.close();
  console.log('\nDone.');
}

main().catch(console.error);
