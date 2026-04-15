/**
 * Test Slate.js prompt input and Create button
 * Key: Slate uses data-slate-node, data-slate-leaf, data-slate-placeholder
 * The placeholder "What do you want to create?" has opacity 0.333
 * Need to properly interact with Slate editor
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
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
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

  const initialCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  console.log('Initial media count:', initialCount);

  // Check slate placeholder state
  console.log('\n=== Slate editor state ===');
  const slateState = await evalJS(ws, `
    JSON.stringify((function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return { found: false };
      const placeholder = ce.querySelector('[data-slate-placeholder]');
      const textLeaf = ce.querySelector('[data-slate-leaf]');
      const actualText = textLeaf ? textLeaf.textContent : '';
      return {
        hasPlaceholder: !!placeholder,
        placeholderVisible: placeholder ? getComputedStyle(placeholder).opacity : null,
        placeholderText: placeholder?.textContent?.substring(0, 60),
        actualLeafText: actualText.substring(0, 80),
        hasRealContent: actualText.length > 0 && !placeholder
      };
    })())
  `);
  console.log(slateState);

  // Strategy 1: CDP click on editor -> type char by char via CDP Input
  console.log('\n=== Strategy 1: CDP click + character input ===');
  const cePos = await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return null;
      const r = ce.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + 10), y: Math.round(r.top + r.height/2) });
    })()
  `);

  if (cePos) {
    const pos = JSON.parse(cePos);
    console.log(`Clicking editor at (${pos.x}, ${pos.y})`);
    await cdpClick(ws, pos.x, pos.y);
    await sleep(500);

    // Select all and delete
    console.log('Selecting all + backspace...');
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 });
    await sleep(300);
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(500);

    // Check state after clear
    const afterClear = await evalJS(ws, `
      (function(){
        const ce = document.querySelector("div[contenteditable='true']");
        if (!ce) return 'no editor';
        const placeholder = ce.querySelector('[data-slate-placeholder]');
        return JSON.stringify({
          text: ce.textContent?.substring(0, 80),
          hasPlaceholder: !!placeholder,
          innerHTML: ce.innerHTML?.substring(0, 200)
        });
      })()
    `);
    console.log('After clear:', afterClear);

    // Type using CDP Input.insertText
    const prompt = 'A tiny robot reading a book in a rainy cafe';
    console.log(`Typing via Input.insertText: "${prompt}"`);
    await sendCDP(ws, 'Input.insertText', { text: prompt });
    await sleep(1000);

    // Check
    const afterType = await evalJS(ws, `
      (function(){
        const ce = document.querySelector("div[contenteditable='true']");
        if (!ce) return 'no editor';
        const placeholder = ce.querySelector('[data-slate-placeholder]');
        return JSON.stringify({
          text: ce.textContent?.substring(0, 80),
          hasPlaceholder: !!placeholder,
          innerHTML: ce.innerHTML?.substring(0, 300)
        });
      })()
    `);
    console.log('After type:', afterType);

    // Check Create button
    const createBtn = await evalJS(ws, `
      (function(){
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent?.trim() || '';
          if (t.includes('arrow_forward') && t.includes('Create') && b.getBoundingClientRect().width > 0) {
            const r = b.getBoundingClientRect();
            return JSON.stringify({
              x: Math.round(r.x + r.width/2),
              y: Math.round(r.y + r.height/2),
              disabled: b.disabled,
              opacity: getComputedStyle(b).opacity,
              cursor: getComputedStyle(b).cursor
            });
          }
        }
        return null;
      })()
    `);
    console.log('Create button:', createBtn);

    if (createBtn) {
      const btn = JSON.parse(createBtn);
      console.log(`\nClicking Create at (${btn.x}, ${btn.y})...`);
      await cdpClick(ws, btn.x, btn.y);
      await sleep(5000);

      const newCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
      console.log(`Media count: ${newCount} (was ${initialCount})`);

      if (newCount > initialCount) {
        console.log('=== SUCCESS! Generation started! ===');
      } else {
        // Strategy 2: Maybe need to type char by char?
        console.log('\n=== Strategy 2: Type char by char ===');
        // Re-focus, clear, type char by char
        await cdpClick(ws, pos.x, pos.y);
        await sleep(300);
        await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
        await sleep(100);
        await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await sleep(500);

        const shortPrompt = 'A sunset over ocean';
        for (const char of shortPrompt) {
          await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char });
          await sendCDP(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: char });
          await sleep(30);
        }
        await sleep(1000);

        const afterCharType = await evalJS(ws, `document.querySelector("div[contenteditable='true']")?.textContent`);
        console.log('After char type:', afterCharType?.substring(0, 80));

        // Click Create
        await cdpClick(ws, btn.x, btn.y);
        await sleep(5000);
        const count2 = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
        console.log(`Media count: ${count2}`);

        if (count2 > initialCount) {
          console.log('=== SUCCESS with char-by-char! ===');
        } else {
          console.log('=== STILL FAILED ===');
          // Check final state
          const finalContent = await evalJS(ws, `document.querySelector("div[contenteditable='true']")?.textContent`);
          console.log('Final content:', finalContent?.substring(0, 80));
        }
      }
    }
  }

  ws.close();
  console.log('\nDone');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
