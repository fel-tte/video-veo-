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

async function main() {
  const pages = await getPages();
  const ws = await connectToPage(pages[0].webSocketDebuggerUrl);

  // Go to Flow main page
  console.log('Step 1: Navigate to Flow main...');
  await sendCDP(ws, 'Page.navigate', { url: 'https://labs.google/fx/tools/flow' });
  await new Promise(r => setTimeout(r, 8000));

  let url = await evalJS(ws, 'window.location.href');
  console.log('URL:', url);
  const text = await evalJS(ws, 'document.body?.innerText?.substring(0,2000) || ""');
  console.log('Text:', text.substring(0, 500));

  // Click "Create with Flow" or "Get Started"
  console.log('\n\nStep 2: Click Create with Flow...');
  const clicked = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button, a');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Create with Flow') || t === 'Get Started') && b.getBoundingClientRect().width > 0) {
          b.click();
          return 'Clicked: ' + t;
        }
      }
      // Try the first "Get Started" link
      const links = document.querySelectorAll('a');
      for (const a of links) {
        if (a.href?.includes('flow') && a.textContent?.includes('Started')) {
          a.click();
          return 'Clicked link: ' + a.href;
        }
      }
      return 'Not found';
    })()
  `);
  console.log(clicked);
  await new Promise(r => setTimeout(r, 8000));

  // Check what page we're on now
  url = await evalJS(ws, 'window.location.href');
  console.log('New URL:', url);

  // Check all pages (maybe a new tab opened)
  ws.close();
  const newPages = await getPages();
  console.log('\nAll pages after click:');
  newPages.forEach(p => console.log('  ' + p.url + ' - ' + p.title));

  // Connect to the newest/most relevant page
  let targetPage = newPages.find(p => p.url.includes('flow/project') || p.url.includes('flow/create'));
  if (!targetPage) targetPage = newPages.find(p => p.url.includes('flow'));
  if (!targetPage) targetPage = newPages[newPages.length - 1];

  const ws2 = await connectToPage(targetPage.webSocketDebuggerUrl);
  console.log('\nConnected to:', targetPage.url);
  await new Promise(r => setTimeout(r, 3000));

  url = await evalJS(ws2, 'window.location.href');
  console.log('Current URL:', url);

  // Get full page content
  const fullText = await evalJS(ws2, 'document.body?.innerText || ""');
  console.log('\n========== FULL PAGE TEXT ==========');
  console.log(fullText);

  // All buttons
  const btns = await evalJS(ws2, `
    JSON.stringify(
      Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter(b => b.getBoundingClientRect().width > 0)
        .map((b,i) => ({ i, text: b.textContent?.trim()?.substring(0,100), disabled: b.disabled }))
    )
  `);
  console.log('\n========== ALL BUTTONS ==========');
  console.log(btns);

  // Prompt input
  const prompt = await evalJS(ws2, `
    JSON.stringify((function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return { found: false };
      return { found: true, text: ce.textContent?.substring(0,100), w: Math.round(ce.getBoundingClientRect().width) };
    })())
  `);
  console.log('\n========== PROMPT ==========');
  console.log(prompt);

  // All links
  const links = await evalJS(ws2, `
    JSON.stringify(
      Array.from(document.querySelectorAll('a[href]'))
        .filter(a => a.href.includes('flow'))
        .map(a => ({ text: a.textContent?.trim()?.substring(0,60), href: a.href }))
    )
  `);
  console.log('\n========== FLOW LINKS ==========');
  console.log(links);

  // Media items
  const items = await evalJS(ws2, `document.querySelectorAll('[id^="fe_id_"]').length`);
  console.log('\nMedia items:', items);

  // If we have the prompt, click model selector
  if (JSON.parse(prompt).found) {
    console.log('\n========== CLICKING MODEL SELECTOR ==========');
    const mClick = await evalJS(ws2, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t.includes('Nano') || t.includes('Banana') || t.includes('Veo')) && b.getBoundingClientRect().width > 0) {
            b.click();
            return 'Clicked: ' + t.substring(0,80);
          }
        }
        return 'Not found';
      })()
    `);
    console.log(mClick);
    await new Promise(r => setTimeout(r, 2000));

    // Get model options
    const opts = await evalJS(ws2, `
      JSON.stringify((function(){
        const items = [];
        document.querySelectorAll('[data-radix-popper-content-wrapper] *, [data-state="open"] *, [role="menu"] *, [role="menuitem"], [role="option"]').forEach(el => {
          if (el.getBoundingClientRect().width > 0 && el.textContent?.trim()) {
            const t = el.textContent.trim();
            if (t.length < 120 && !items.some(i => i.text === t)) {
              items.push({
                text: t,
                tag: el.tagName,
                checked: el.getAttribute('data-state') === 'checked',
                role: el.getAttribute('role') || ''
              });
            }
          }
        });
        return items;
      })())
    `);
    console.log('\nModel dropdown options:');
    console.log(opts);

    // Close
    await evalJS(ws2, 'document.body.click()');
    await new Promise(r => setTimeout(r, 500));

    // Click aspect ratio selector if exists
    console.log('\n========== ASPECT RATIO ==========');
    const arClick = await evalJS(ws2, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if (t.includes('crop') && b.getBoundingClientRect().width > 0) {
            b.click();
            return 'Clicked: ' + t.substring(0,80);
          }
        }
        return 'Not found';
      })()
    `);
    console.log(arClick);
    await new Promise(r => setTimeout(r, 2000));

    const arOpts = await evalJS(ws2, `
      JSON.stringify((function(){
        const items = [];
        document.querySelectorAll('[data-radix-popper-content-wrapper] *, [data-state="open"] *').forEach(el => {
          if (el.getBoundingClientRect().width > 0 && el.textContent?.trim()) {
            const t = el.textContent.trim();
            if (t.length < 80 && !items.some(i => i.text === t)) {
              items.push({ text: t, checked: el.getAttribute('data-state') === 'checked' });
            }
          }
        });
        return items;
      })())
    `);
    console.log('Aspect ratio options:', arOpts);
    await evalJS(ws2, 'document.body.click()');
    await new Promise(r => setTimeout(r, 500));

    // Click output count (x2, x4)
    console.log('\n========== OUTPUT COUNT ==========');
    const countClick = await evalJS(ws2, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if ((t === 'x2' || t === 'x4' || t.match(/^x[0-9]+$/)) && b.getBoundingClientRect().width > 0) {
            b.click();
            return 'Clicked: ' + t;
          }
        }
        return 'Not found';
      })()
    `);
    console.log(countClick);
    await new Promise(r => setTimeout(r, 2000));

    const countOpts = await evalJS(ws2, `
      JSON.stringify((function(){
        const items = [];
        document.querySelectorAll('[data-radix-popper-content-wrapper] *, [data-state="open"] *').forEach(el => {
          if (el.getBoundingClientRect().width > 0 && el.textContent?.trim()) {
            const t = el.textContent.trim();
            if (t.length < 40 && !items.some(i => i.text === t)) {
              items.push({ text: t, checked: el.getAttribute('data-state') === 'checked' });
            }
          }
        });
        return items;
      })())
    `);
    console.log('Count options:', countOpts);
    await evalJS(ws2, 'document.body.click()');
  }

  // Navigate to a media detail page
  if (items > 0) {
    console.log('\n========== MEDIA DETAIL ==========');
    const href = await evalJS(ws2, `document.querySelector('[id^="fe_id_"] a')?.href || ''`);
    if (href) {
      await sendCDP(ws2, 'Page.navigate', { url: href });
      await new Promise(r => setTimeout(r, 5000));
      const dText = await evalJS(ws2, 'document.body?.innerText?.substring(0,2000) || ""');
      console.log(dText);

      const dBtns = await evalJS(ws2, `
        JSON.stringify(
          Array.from(document.querySelectorAll('button'))
            .filter(b => b.getBoundingClientRect().width > 0)
            .map(b => ({ text: b.textContent?.trim()?.substring(0,80) }))
        )
      `);
      console.log('\nButtons:', dBtns);

      const dVids = await evalJS(ws2, `
        JSON.stringify(
          Array.from(document.querySelectorAll('video')).map(v => ({
            src: v.src?.substring(0,300) || '',
            currentSrc: v.currentSrc?.substring(0,300) || ''
          }))
        )
      `);
      console.log('\nVideos:', dVids);
    }
  }

  ws2.close();
  console.log('\nDone.');
}

main().catch(console.error);
