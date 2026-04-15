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
  console.log('Pages:', pages.map(p => p.url));

  let page = pages.find(p => p.url.includes('flow/project'));
  if (!page) page = pages.find(p => p.url.includes('flow'));
  if (!page) page = pages[0];

  const ws = await connectToPage(page.webSocketDebuggerUrl);
  console.log('Connected to:', page.url);

  // 1. Full page text and structure
  console.log('\n========== FULL PAGE TEXT ==========');
  const pageText = await evalJS(ws, 'document.body?.innerText || ""');
  console.log(pageText);

  // 2. All buttons with their full info
  console.log('\n========== ALL VISIBLE BUTTONS ==========');
  const buttons = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(b => b.getBoundingClientRect().width > 0)
        .map(b => ({
          text: b.textContent?.trim()?.substring(0, 120),
          ariaLabel: b.getAttribute('aria-label') || '',
          title: b.title || '',
          disabled: b.disabled,
          className: b.className?.substring?.(0, 80) || '',
          id: b.id || '',
          rect: { w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }
        }))
    )
  `);
  console.log(buttons);

  // 3. Model/settings dropdown area
  console.log('\n========== MODEL SELECTOR AREA ==========');
  const modelArea = await evalJS(ws, `
    (function() {
      // Find the bottom bar area with model selector
      const bottomArea = document.querySelector('[class*="prompt"], [class*="bottom"], [class*="toolbar"]');

      // Find all buttons near the prompt area
      const promptParent = document.querySelector("div[contenteditable='true']")?.closest('div[class]');
      if (!promptParent) return 'No prompt parent found';

      // Walk up to find the container with all controls
      let container = promptParent;
      for (let i = 0; i < 5; i++) {
        container = container.parentElement;
        if (!container) break;
      }

      if (!container) return 'No container found';

      // Get all interactive elements in this container
      const elements = [];
      container.querySelectorAll('button, [role="button"], select, input, [role="combobox"], [role="listbox"]').forEach(el => {
        if (el.getBoundingClientRect().width > 0) {
          elements.push({
            tag: el.tagName,
            text: el.textContent?.trim()?.substring(0, 100),
            ariaLabel: el.getAttribute('aria-label') || '',
            role: el.getAttribute('role') || '',
            id: el.id || '',
            type: el.type || ''
          });
        }
      });

      return JSON.stringify(elements, null, 2);
    })()
  `);
  console.log(modelArea);

  // 4. Click model selector to see dropdown options
  console.log('\n========== CLICKING MODEL SELECTOR ==========');
  const clickResult = await evalJS(ws, `
    (function() {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        if ((text.includes('Nano') || text.includes('Banana') || text.includes('Veo')) && btn.getBoundingClientRect().width > 0) {
          btn.click();
          return 'Clicked: ' + text.substring(0, 80);
        }
      }
      return 'Model button not found';
    })()
  `);
  console.log(clickResult);

  await new Promise(r => setTimeout(r, 2000));

  // 5. Get dropdown/popover content after click
  console.log('\n========== DROPDOWN/POPOVER CONTENT ==========');
  const dropdownContent = await evalJS(ws, `
    (function() {
      // Look for popover/dropdown/menu elements
      const selectors = [
        '[role="menu"]', '[role="listbox"]', '[data-radix-popper-content-wrapper]',
        '[data-state="open"]', '[class*="popover"]', '[class*="dropdown"]',
        '[class*="menu"]', '[class*="select"]', '[role="dialog"]'
      ];

      const results = [];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => {
          if (el.getBoundingClientRect().width > 0) {
            results.push({
              selector: sel,
              text: el.textContent?.trim()?.substring(0, 500),
              childCount: el.children.length,
              tag: el.tagName,
              className: el.className?.substring?.(0, 80) || ''
            });
          }
        });
      }

      // Also check for any new elements that appeared
      const allVisible = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [data-radix-collection-item]'))
        .filter(e => e.getBoundingClientRect().width > 0)
        .map(e => ({
          text: e.textContent?.trim()?.substring(0, 100),
          role: e.getAttribute('role') || '',
          tag: e.tagName
        }));

      return JSON.stringify({ popoverElements: results, menuItems: allVisible }, null, 2);
    })()
  `);
  console.log(dropdownContent);

  // 6. Close dropdown and check aspect ratio / output count
  await evalJS(ws, `document.body.click()`);
  await new Promise(r => setTimeout(r, 1000));

  // 7. Look for aspect ratio selector
  console.log('\n========== ASPECT RATIO / SETTINGS ==========');
  const settingsArea = await evalJS(ws, `
    (function() {
      // Find buttons with aspect ratio icons (crop_16_9, crop_3_2, etc)
      const aspectBtns = Array.from(document.querySelectorAll('button'))
        .filter(b => {
          const text = b.textContent?.trim() || '';
          return (text.includes('crop') || text.includes('x') || text.includes('16:9') ||
                  text.includes('9:16') || text.includes('1:1') || text.includes('aspect')) &&
                 b.getBoundingClientRect().width > 0;
        })
        .map(b => ({
          text: b.textContent?.trim()?.substring(0, 80),
          ariaLabel: b.getAttribute('aria-label') || '',
          className: b.className?.substring?.(0, 60) || ''
        }));

      // Find all icons/text that relate to settings
      const settingsTexts = [];
      document.querySelectorAll('*').forEach(el => {
        if (el.children.length === 0 && el.getBoundingClientRect().width > 0) {
          const text = el.textContent?.trim();
          if (text && (text.includes('crop') || text.includes('x2') || text.includes('x4') ||
              text.includes('16:9') || text.includes('resolution') || text.includes('quality') ||
              text.includes('duration') || text.includes('seed') || text.includes('negative'))) {
            settingsTexts.push({ text: text.substring(0, 60), tag: el.tagName });
          }
        }
      });

      return JSON.stringify({ aspectButtons: aspectBtns, settingsTexts: settingsTexts }, null, 2);
    })()
  `);
  console.log(settingsArea);

  // 8. Get the complete bottom bar / prompt area HTML structure
  console.log('\n========== PROMPT BAR STRUCTURE ==========');
  const promptBar = await evalJS(ws, `
    (function() {
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return 'No contenteditable found';

      // Go up to the main prompt container
      let container = ce;
      for (let i = 0; i < 8; i++) {
        if (container.parentElement) container = container.parentElement;
      }

      function describeElement(el, depth) {
        if (depth > 4 || !el) return '';
        const tag = el.tagName?.toLowerCase() || '';
        const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
          ? ' "' + el.textContent.trim().substring(0, 40) + '"' : '';
        const attrs = [];
        if (el.id) attrs.push('id=' + el.id);
        if (el.getAttribute('role')) attrs.push('role=' + el.getAttribute('role'));
        if (el.getAttribute('contenteditable')) attrs.push('contenteditable');
        if (el.getAttribute('aria-label')) attrs.push('aria-label="' + el.getAttribute('aria-label') + '"');
        if (el.disabled) attrs.push('disabled');

        const attrStr = attrs.length ? ' [' + attrs.join(', ') + ']' : '';
        const indent = '  '.repeat(depth);
        let result = indent + tag + attrStr + text + '\\n';

        if (el.children.length <= 15 && el.children.length > 0) {
          Array.from(el.children).forEach(child => {
            result += describeElement(child, depth + 1);
          });
        } else if (el.children.length > 15) {
          result += indent + '  (' + el.children.length + ' children)\\n';
        }
        return result;
      }

      return describeElement(container, 0);
    })()
  `);
  console.log(promptBar);

  // 9. Check for existing generated items and their details
  console.log('\n========== GENERATED MEDIA ITEMS ==========');
  const mediaItems = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('[id^="fe_id_"]')).map(el => {
        const link = el.querySelector('a');
        const video = el.querySelector('video');
        const img = el.querySelector('img');
        return {
          id: el.id,
          href: link?.href?.substring(0, 150) || '',
          hasVideo: !!video,
          videoSrc: video?.src?.substring(0, 100) || '',
          hasImg: !!img,
          imgSrc: img?.src?.substring(0, 100) || '',
          text: el.textContent?.trim()?.substring(0, 50) || ''
        };
      })
    )
  `);
  console.log(mediaItems);

  // 10. Click on a media item to see detail view options
  console.log('\n========== CLICKING FIRST MEDIA ITEM ==========');
  const clickMedia = await evalJS(ws, `
    (function() {
      const items = document.querySelectorAll('[id^="fe_id_"]');
      if (items.length === 0) return 'No media items';
      const link = items[0].querySelector('a');
      if (link) {
        link.click();
        return 'Clicked: ' + items[0].id;
      }
      items[0].click();
      return 'Clicked item directly: ' + items[0].id;
    })()
  `);
  console.log(clickMedia);

  await new Promise(r => setTimeout(r, 3000));

  // 11. Get detail view elements
  console.log('\n========== MEDIA DETAIL VIEW ==========');
  const detailView = await evalJS(ws, `
    (function() {
      const url = window.location.href;
      const pageText = document.body?.innerText?.substring(0, 3000) || '';

      const buttons = Array.from(document.querySelectorAll('button'))
        .filter(b => b.getBoundingClientRect().width > 0)
        .map(b => ({
          text: b.textContent?.trim()?.substring(0, 80),
          ariaLabel: b.getAttribute('aria-label') || ''
        }));

      const videos = Array.from(document.querySelectorAll('video')).map(v => ({
        src: v.src?.substring(0, 200) || '',
        currentSrc: v.currentSrc?.substring(0, 200) || '',
        poster: v.poster?.substring(0, 200) || ''
      }));

      const links = Array.from(document.querySelectorAll('a[download], a[href*="download"]')).map(a => ({
        href: a.href?.substring(0, 200) || '',
        download: a.download || '',
        text: a.textContent?.trim()?.substring(0, 50) || ''
      }));

      return JSON.stringify({ url, buttons, videos, downloadLinks: links, pageText: pageText.substring(0, 1500) }, null, 2);
    })()
  `);
  console.log(detailView);

  ws.close();
  console.log('\nDone.');
}

main().catch(console.error);
