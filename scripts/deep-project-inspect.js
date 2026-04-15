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
  const { result } = await sendCDP(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.value;
}

async function main() {
  const pages = await getPages();
  const ws = await connectToPage(pages[0].webSocketDebuggerUrl);

  // Navigate to the project page
  console.log('Navigating to project...');
  await sendCDP(ws, 'Page.navigate', { url: 'https://labs.google/fx/tools/flow/project/ff1af752-3ed8-46f4-86ed-740aecca9681' });
  await new Promise(r => setTimeout(r, 8000));

  console.log('URL:', await evalJS(ws, 'window.location.href'));
  console.log('\n========== PAGE TEXT ==========');
  console.log(await evalJS(ws, 'document.body?.innerText || ""'));

  // ALL buttons
  console.log('\n========== ALL BUTTONS ==========');
  console.log(await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter(b => b.getBoundingClientRect().width > 0)
        .map((b,i) => ({ i, text: b.textContent?.trim()?.substring(0,100), disabled: b.disabled, id: b.id || '' })),
      null, 2
    )
  `));

  // Prompt area
  console.log('\n========== PROMPT ==========');
  console.log(await evalJS(ws, `
    JSON.stringify((function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return { found: false };
      return { found: true, text: ce.textContent?.substring(0,100), placeholder: ce.getAttribute('data-placeholder') || '' };
    })())
  `));

  // === MODEL SELECTOR ===
  console.log('\n========== MODEL SELECTOR - CLICK ==========');
  console.log(await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Banana') || t.includes('Veo')) && b.getBoundingClientRect().width > 0) {
          b.click();
          return 'Clicked: ' + t;
        }
      }
      return 'Not found';
    })()
  `));
  await new Promise(r => setTimeout(r, 2000));

  console.log('\n========== MODEL OPTIONS (DROPDOWN) ==========');
  console.log(await evalJS(ws, `
    JSON.stringify((function(){
      // Get ALL visible text in dropdowns/popovers
      const containers = document.querySelectorAll('[data-radix-popper-content-wrapper]');
      if (containers.length === 0) return { note: 'No radix popper found', allDropdowns: [] };

      const results = [];
      containers.forEach(c => {
        if (c.getBoundingClientRect().width > 0) {
          results.push({
            fullText: c.textContent?.trim()?.substring(0, 1000),
            html: c.innerHTML?.substring(0, 2000)
          });
        }
      });

      // Also try other dropdown mechanisms
      const openElements = document.querySelectorAll('[data-state="open"]');
      openElements.forEach(el => {
        if (el.getBoundingClientRect().width > 0 && el.children.length > 0) {
          const items = Array.from(el.querySelectorAll('*')).filter(e =>
            e.children.length === 0 && e.getBoundingClientRect().width > 0 && e.textContent?.trim()
          ).map(e => e.textContent.trim()).filter(t => t.length < 60);
          if (items.length > 0) {
            results.push({ type: 'open-state', items: [...new Set(items)] });
          }
        }
      });

      return results;
    })(), null, 2)
  `));

  // Close dropdown
  await evalJS(ws, `
    (function(){
      const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
      document.dispatchEvent(esc);
    })()
  `);
  await new Promise(r => setTimeout(r, 1000));

  // === ASPECT RATIO ===
  console.log('\n========== ASPECT RATIO - CLICK ==========');
  console.log(await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('crop_') && b.getBoundingClientRect().width > 0) {
          b.click();
          return 'Clicked: ' + t;
        }
      }
      return 'Not found - listing all short button texts: ' + Array.from(document.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0).map(b => b.textContent?.trim()?.substring(0,30)).join(' | ');
    })()
  `));
  await new Promise(r => setTimeout(r, 2000));

  console.log('\n========== ASPECT RATIO OPTIONS ==========');
  console.log(await evalJS(ws, `
    JSON.stringify((function(){
      const containers = document.querySelectorAll('[data-radix-popper-content-wrapper]');
      const results = [];
      containers.forEach(c => {
        if (c.getBoundingClientRect().width > 0) {
          results.push(c.textContent?.trim()?.substring(0, 500));
        }
      });
      return results;
    })())
  `));
  await evalJS(ws, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise(r => setTimeout(r, 500));

  // === OUTPUT COUNT (x2) ===
  console.log('\n========== OUTPUT COUNT - CLICK ==========');
  console.log(await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.match(/^x[0-9]/) && b.getBoundingClientRect().width > 0) {
          b.click();
          return 'Clicked: ' + t;
        }
      }
      return 'Not found';
    })()
  `));
  await new Promise(r => setTimeout(r, 2000));

  console.log('\n========== OUTPUT COUNT OPTIONS ==========');
  console.log(await evalJS(ws, `
    JSON.stringify((function(){
      const containers = document.querySelectorAll('[data-radix-popper-content-wrapper]');
      const results = [];
      containers.forEach(c => {
        if (c.getBoundingClientRect().width > 0) {
          results.push(c.textContent?.trim()?.substring(0, 500));
        }
      });
      return results;
    })())
  `));
  await evalJS(ws, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise(r => setTimeout(r, 500));

  // === MEDIA DETAIL VIEW ===
  console.log('\n========== MEDIA ITEMS ==========');
  const mediaData = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('[id^="fe_id_"]')).map(el => ({
        id: el.id,
        href: el.querySelector('a')?.href || ''
      }))
    )
  `);
  console.log(mediaData);

  const mediaArr = JSON.parse(mediaData || '[]');
  if (mediaArr.length > 0 && mediaArr[0].href) {
    console.log('\n========== NAVIGATING TO MEDIA DETAIL ==========');
    await sendCDP(ws, 'Page.navigate', { url: mediaArr[0].href });
    await new Promise(r => setTimeout(r, 6000));

    console.log('URL:', await evalJS(ws, 'window.location.href'));
    console.log('\n--- Detail Page Text ---');
    console.log(await evalJS(ws, 'document.body?.innerText?.substring(0,3000) || ""'));

    console.log('\n--- Detail Buttons ---');
    console.log(await evalJS(ws, `
      JSON.stringify(
        Array.from(document.querySelectorAll('button'))
          .filter(b => b.getBoundingClientRect().width > 0)
          .map(b => ({ text: b.textContent?.trim()?.substring(0,80), ariaLabel: b.getAttribute('aria-label') || '' }))
      )
    `));

    console.log('\n--- Videos ---');
    console.log(await evalJS(ws, `
      JSON.stringify(
        Array.from(document.querySelectorAll('video')).map(v => ({
          src: v.src?.substring(0,300) || '',
          currentSrc: v.currentSrc?.substring(0,300) || '',
          width: v.videoWidth, height: v.videoHeight
        }))
      )
    `));

    console.log('\n--- Download links ---');
    console.log(await evalJS(ws, `
      JSON.stringify(
        Array.from(document.querySelectorAll('a')).filter(a =>
          a.textContent?.toLowerCase().includes('download') || a.hasAttribute('download') || a.href?.includes('download')
        ).map(a => ({ text: a.textContent?.trim()?.substring(0,80), href: a.href?.substring(0,200), download: a.download || '' }))
      )
    `));
  }

  ws.close();
  console.log('\nDone.');
}

main().catch(console.error);
