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
    const timeout = setTimeout(() => reject(new Error('CDP timeout ' + method)), 30000);
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
  const page = pages[0];
  const ws = await connectToPage(page.webSocketDebuggerUrl);

  // Step 1: Navigate to Flow create
  console.log('Step 1: Navigate to Flow create...');
  await sendCDP(ws, 'Page.navigate', { url: 'https://labs.google/fx/tools/flow/create' });
  await new Promise(r => setTimeout(r, 10000));

  let url = await evalJS(ws, 'window.location.href');
  console.log('URL:', url);

  // Step 2: Full page text
  console.log('\n========== PAGE TEXT ==========');
  const text = await evalJS(ws, 'document.body?.innerText || ""');
  console.log(text);

  // Step 3: All visible buttons
  console.log('\n========== ALL BUTTONS ==========');
  const btns = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter(b => b.getBoundingClientRect().width > 0)
        .map((b,i) => ({
          idx: i,
          text: b.textContent?.trim()?.substring(0,100),
          ariaLabel: b.getAttribute('aria-label') || '',
          disabled: b.disabled,
          id: b.id || ''
        }))
    )
  `);
  console.log(btns);

  // Step 4: Prompt area
  console.log('\n========== PROMPT INPUT ==========');
  const promptInfo = await evalJS(ws, `
    JSON.stringify((function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return { found: false };
      return {
        found: true,
        text: ce.textContent?.substring(0,100),
        width: Math.round(ce.getBoundingClientRect().width),
        height: Math.round(ce.getBoundingClientRect().height)
      };
    })())
  `);
  console.log(promptInfo);

  // Step 5: Click model selector
  console.log('\n========== MODEL SELECTOR ==========');
  const modelClick = await evalJS(ws, `
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
  console.log(modelClick);
  await new Promise(r => setTimeout(r, 2000));

  // Step 6: Get dropdown options
  console.log('\n========== MODEL OPTIONS ==========');
  const modelOpts = await evalJS(ws, `
    JSON.stringify((function(){
      // radix dropdown content
      const poppers = document.querySelectorAll('[data-radix-popper-content-wrapper], [data-state="open"], [role="menu"], [role="listbox"]');
      const results = [];
      poppers.forEach(p => {
        if (p.getBoundingClientRect().width > 0) {
          // Get items inside
          const items = Array.from(p.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"], [data-radix-collection-item], button, div[tabindex]'))
            .filter(i => i.getBoundingClientRect().width > 0)
            .map(i => ({
              text: i.textContent?.trim()?.substring(0,120),
              checked: i.getAttribute('data-state') === 'checked' || i.getAttribute('aria-checked') === 'true',
              role: i.getAttribute('role') || ''
            }));
          results.push({
            fullText: p.textContent?.trim()?.substring(0,500),
            items: items
          });
        }
      });

      // Also look for any visible overlay/dialog
      const overlays = document.querySelectorAll('[class*="overlay"], [class*="modal"], [class*="sheet"]');
      overlays.forEach(o => {
        if (o.getBoundingClientRect().width > 0) {
          results.push({
            type: 'overlay',
            text: o.textContent?.trim()?.substring(0,500),
            className: o.className?.substring?.(0,80)
          });
        }
      });

      return results;
    })())
  `);
  console.log(modelOpts);

  // Close dropdown
  await evalJS(ws, 'document.body.click()');
  await new Promise(r => setTimeout(r, 500));

  // Step 7: Full prompt bar HTML tree
  console.log('\n========== PROMPT BAR TREE ==========');
  const tree = await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return 'No CE';
      let c = ce;
      for (let i = 0; i < 6; i++) { if (c.parentElement) c = c.parentElement; }

      function desc(el, d) {
        if (d > 5 || !el) return '';
        const t = el.tagName?.toLowerCase() || '';
        const txt = (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3)
          ? ' "' + el.textContent.trim().substring(0,50) + '"' : '';
        const a = [];
        if (el.id) a.push('#'+el.id);
        if (el.getAttribute('contenteditable')) a.push('CE');
        if (el.getAttribute('role')) a.push('role='+el.getAttribute('role'));
        if (el.getAttribute('aria-label')) a.push('label="'+el.getAttribute('aria-label')+'"');
        if (el.tagName === 'BUTTON') a.push('btn');
        if (el.tagName === 'INPUT') a.push('input:'+el.type);
        const as = a.length ? ' ['+a.join(',')+']' : '';
        let r = '  '.repeat(d) + t + as + txt + '\\n';
        if (el.children.length <= 20) {
          Array.from(el.children).forEach(ch => { r += desc(ch, d+1); });
        } else {
          r += '  '.repeat(d+1) + '(' + el.children.length + ' children)\\n';
        }
        return r;
      }
      return desc(c, 0);
    })()
  `);
  console.log(tree);

  // Step 8: Check for aspect ratio, num outputs, and other settings
  console.log('\n========== SETTINGS TEXT ELEMENTS ==========');
  const settings = await evalJS(ws, `
    JSON.stringify((function(){
      const texts = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        const t = node.textContent?.trim();
        if (t && t.length > 0 && t.length < 60) {
          const parent = node.parentElement;
          if (parent && parent.getBoundingClientRect().width > 0) {
            if (t.match(/crop|16.9|9.16|1.1|3.2|4.3|aspect|ratio|x[0-9]|nano|banana|veo|model|quality|resolution|duration|seed|negative|style|1080|720|4k|hd|output|count|number|generate/i)) {
              texts.push({ text: t, tag: parent.tagName, className: parent.className?.substring?.(0,40) });
            }
          }
        }
      }
      return texts;
    })())
  `);
  console.log(settings);

  // Step 9: Get existing media items
  console.log('\n========== MEDIA ITEMS ==========');
  const media = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('[id^="fe_id_"]')).map(el => ({
        id: el.id,
        href: el.querySelector('a')?.href?.substring(0,150) || ''
      }))
    )
  `);
  console.log(media);

  // Step 10: Navigate to a media item detail page if available
  const mediaArr = JSON.parse(media || '[]');
  if (mediaArr.length > 0 && mediaArr[0].href) {
    console.log('\n========== NAVIGATING TO MEDIA DETAIL ==========');
    await sendCDP(ws, 'Page.navigate', { url: mediaArr[0].href });
    await new Promise(r => setTimeout(r, 5000));

    url = await evalJS(ws, 'window.location.href');
    console.log('Detail URL:', url);

    const detailText = await evalJS(ws, 'document.body?.innerText?.substring(0,3000) || ""');
    console.log('\nDetail Text:', detailText);

    const detailBtns = await evalJS(ws, `
      JSON.stringify(
        Array.from(document.querySelectorAll('button'))
          .filter(b => b.getBoundingClientRect().width > 0)
          .map(b => ({
            text: b.textContent?.trim()?.substring(0,80),
            ariaLabel: b.getAttribute('aria-label') || ''
          }))
      )
    `);
    console.log('\nDetail Buttons:', detailBtns);

    const detailVideos = await evalJS(ws, `
      JSON.stringify(
        Array.from(document.querySelectorAll('video')).map(v => ({
          src: v.src?.substring(0,300) || '',
          currentSrc: v.currentSrc?.substring(0,300) || '',
          poster: v.poster?.substring(0,200) || '',
          width: v.videoWidth,
          height: v.videoHeight
        }))
      )
    `);
    console.log('\nDetail Videos:', detailVideos);
  }

  ws.close();
  console.log('\nDone.');
}

main().catch(console.error);
