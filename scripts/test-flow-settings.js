// Deep inspect Flow settings dropdown - find Image/Video toggle
const WebSocket = require('ws');
const fs = require('fs');

const CDP_URL = 'http://127.0.0.1:9222';
const PROJECT_URL = 'https://labs.google/fx/tools/flow/project/4c186f91-4074-42e9-93a8-ed19c00a0da6';

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

async function getPage() {
  const resp = await fetch(`${CDP_URL}/json`);
  const pages = await resp.json();
  return pages.find(p => p.url.includes('labs.google'));
}

async function connectCDP(page) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 1;
    const pending = new Map();
    let eh = null;
    ws.on('open', () => resolve({
      send(m, p = {}) { return new Promise((res, rej) => { const i = id++; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); }); },
      onEvent(h) { eh = h; },
      close() { ws.close(); }
    }));
    ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      else if (m.method && eh) eh(m.method, m.params);
    });
    ws.on('error', reject);
  });
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
}

async function screenshot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`scripts/${name}.png`, Buffer.from(r.data, 'base64'));
  log(`Screenshot saved: scripts/${name}.png`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const page = await getPage();
  if (!page) { log('No page found'); return; }
  const cdp = await connectCDP(page);

  try {
    // Make sure on project page
    const url = await evaluate(cdp, 'window.location.href');
    if (!url.includes('project/')) {
      log('Navigating to project...');
      await cdp.send('Page.navigate', { url: PROJECT_URL });
      await sleep(5000);
    }
    log(`URL: ${await evaluate(cdp, 'window.location.href')}`);

    // Screenshot before
    await screenshot(cdp, 'flow-before-click');

    // Step 1: Click settings button
    log('\n=== Click settings button ===');
    const clicked = await evaluate(cdp, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.includes('crop_') && b.getBoundingClientRect().y > 500);
        if (btn) {
          btn.click();
          return JSON.stringify({
            text: btn.textContent.trim(),
            rect: btn.getBoundingClientRect().toJSON(),
            ariaPop: btn.getAttribute('aria-haspopup'),
            ariaExp: btn.getAttribute('aria-expanded')
          });
        }
        return 'not found';
      })()
    `);
    log(`Clicked: ${clicked}`);
    await sleep(2000); // Wait longer for dropdown to render

    // Screenshot after click
    await screenshot(cdp, 'flow-after-settings-click');

    // Step 2: Scan EVERYTHING that appeared
    log('\n=== Scan all new elements ===');
    const newElements = await evaluate(cdp, `
      (() => {
        // Find all popover/floating elements
        const floating = document.querySelectorAll('[data-radix-popper-content-wrapper], [role="dialog"], [role="menu"], [role="listbox"], [data-state="open"], .popover, [id*="radix"]');
        const result = { floating: [] };
        for (const el of floating) {
          result.floating.push({
            tag: el.tagName,
            id: el.id,
            role: el.getAttribute('role'),
            state: el.getAttribute('data-state'),
            html: el.innerHTML.substring(0, 2000),
            text: el.textContent.trim().substring(0, 500),
            childCount: el.children.length,
            rect: el.getBoundingClientRect().toJSON()
          });
        }

        // Also scan for any element with z-index > 10 (floating)
        const allEls = document.querySelectorAll('*');
        result.highZ = [];
        for (const el of allEls) {
          const style = window.getComputedStyle(el);
          const z = parseInt(style.zIndex);
          if (z > 10 && el.getBoundingClientRect().width > 50) {
            result.highZ.push({
              tag: el.tagName,
              id: el.id?.substring(0,30),
              zIndex: z,
              text: el.textContent.trim().substring(0, 200),
              rect: { y: Math.round(el.getBoundingClientRect().y), h: Math.round(el.getBoundingClientRect().height) }
            });
          }
        }

        return JSON.stringify(result);
      })()
    `);
    log(`Floating elements: ${newElements}`);

    // Step 3: Try a direct DOM traversal from the settings button
    log('\n=== Traverse from settings button ===');
    const traversal = await evaluate(cdp, `
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.includes('crop_') && b.getBoundingClientRect().y > 500);
        if (!btn) return 'no btn';

        // Check siblings, parent's children, nearby elements
        const parent = btn.parentElement;
        const grandparent = parent?.parentElement;
        const ggparent = grandparent?.parentElement;

        const scan = (el, label) => {
          if (!el) return null;
          return {
            label,
            tag: el.tagName,
            childCount: el.children.length,
            text: el.textContent.trim().substring(0, 200),
            html: el.innerHTML.substring(0, 500)
          };
        };

        return JSON.stringify([
          scan(btn, 'button'),
          scan(parent, 'parent'),
          scan(grandparent, 'grandparent'),
          scan(ggparent, 'ggparent')
        ]);
      })()
    `);
    log(`Traversal: ${traversal}`);

    // Step 4: Check aria-controls or aria-owns relationships
    log('\n=== Check aria relationships ===');
    const ariaRels = await evaluate(cdp, `
      (() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.includes('crop_') && b.getBoundingClientRect().y > 500);
        if (!btn) return 'no btn';

        const controls = btn.getAttribute('aria-controls');
        const owns = btn.getAttribute('aria-owns');
        const expanded = btn.getAttribute('aria-expanded');
        const popup = btn.getAttribute('aria-haspopup');

        let controlledEl = null;
        if (controls) controlledEl = document.getElementById(controls);

        return JSON.stringify({
          controls, owns, expanded, popup,
          controlledEl: controlledEl ? {
            tag: controlledEl.tagName,
            text: controlledEl.textContent.trim().substring(0, 500),
            html: controlledEl.innerHTML.substring(0, 1000)
          } : null
        });
      })()
    `);
    log(`Aria: ${ariaRels}`);

    // Step 5: Try clicking the actual text "Video" part of the button
    log('\n=== Try clicking "Video" text directly ===');
    // Close current dropdown first
    await evaluate(cdp, `document.body.click()`);
    await sleep(500);

    const videoTextClick = await evaluate(cdp, `
      (() => {
        // Find all elements containing just "Video" text
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.trim() === 'Video') {
            const parent = walker.currentNode.parentElement;
            const rect = parent.getBoundingClientRect();
            if (rect.y > 500 && rect.width > 0) {
              textNodes.push({
                parentTag: parent.tagName,
                parentText: parent.textContent.trim(),
                rect: rect.toJSON()
              });
              parent.click();
              return JSON.stringify({ clicked: true, node: textNodes[0] });
            }
          }
        }
        return JSON.stringify({ clicked: false, found: textNodes });
      })()
    `);
    log(`Video text click: ${videoTextClick}`);
    await sleep(2000);

    // Screenshot after clicking Video text
    await screenshot(cdp, 'flow-after-video-text-click');

    // Check what appeared
    const afterVideoClick = await evaluate(cdp, `
      (() => {
        const all = document.querySelectorAll('[role="tab"], [role="menuitem"], [role="option"], [data-state="active"], [data-state="inactive"], [data-state="open"]');
        return JSON.stringify(Array.from(all).map(e => ({
          text: e.textContent.trim().substring(0,60),
          role: e.getAttribute('role'),
          state: e.getAttribute('data-state'),
          tag: e.tagName,
          y: Math.round(e.getBoundingClientRect().y)
        })).filter(e => e.y > 0));
      })()
    `);
    log(`After video click elements: ${afterVideoClick}`);

  } finally {
    cdp.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
