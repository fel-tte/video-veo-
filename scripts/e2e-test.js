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

function log(step, msg) {
  console.log(`\n[${'='.repeat(3)} STEP ${step} ${'='.repeat(3)}] ${msg}`);
}

async function main() {
  const TEST_PROMPT = 'A golden retriever running on a beach at sunset, cinematic slow motion, 4K';

  const pages = await getPages();
  const flowPage = pages.find(p => p.url.includes('flow'));
  if (!flowPage) {
    console.error('ERROR: No Flow page found. Open the Flow project in Chrome first.');
    process.exit(1);
  }

  const ws = await connectToPage(flowPage.webSocketDebuggerUrl);
  console.log('Connected to:', flowPage.url);

  // ===== STEP 1: Check page state =====
  log(1, 'Checking page state');
  const url = await evalJS(ws, 'window.location.href');
  console.log('URL:', url);

  // ===== STEP 2: Check login =====
  log(2, 'Checking login status');
  const loggedIn = await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (ce) return 'LOGGED_IN: prompt input found';
      if (document.body.innerText.includes('What do you want to create')) return 'LOGGED_IN: create text found';
      return 'NOT_LOGGED_IN';
    })()
  `);
  console.log('Login:', loggedIn);
  if (loggedIn.startsWith('NOT_LOGGED_IN')) {
    console.error('ERROR: Not logged in. Please login manually first.');
    ws.close();
    process.exit(1);
  }

  // ===== STEP 3: Check current settings =====
  log(3, 'Checking current settings');
  const settings = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      const results = [];
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (b.getBoundingClientRect().width > 0 && t.length < 100) {
          if (t.includes('Nano') || t.includes('Veo') || t.includes('crop_') || t.match(/^x[0-9]/)) {
            results.push(t);
          }
        }
      }
      return results.join(' | ');
    })()
  `);
  console.log('Settings buttons:', settings);

  // ===== STEP 4: Test model dropdown =====
  log(4, 'Testing model dropdown');
  const modelClick = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && t.includes('crop_') && b.getBoundingClientRect().width > 0) {
          b.click();
          return 'Clicked combined settings: ' + t.substring(0, 80);
        }
      }
      // Try individual model button
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if ((t.includes('Nano') || t.includes('Veo')) && b.getBoundingClientRect().width > 0 && !t.includes('Create')) {
          b.click();
          return 'Clicked model: ' + t.substring(0, 60);
        }
      }
      return 'Not found';
    })()
  `);
  console.log(modelClick);
  await new Promise(r => setTimeout(r, 2000));

  // Check what appeared
  const dropdown = await evalJS(ws, `
    JSON.stringify((function(){
      const results = [];
      // Radix popper
      document.querySelectorAll('[data-radix-popper-content-wrapper]').forEach(el => {
        if (el.getBoundingClientRect().width > 0) results.push({type:'radix', text: el.textContent?.trim()?.substring(0,300)});
      });
      // data-state=open
      document.querySelectorAll('[data-state="open"]').forEach(el => {
        if (el.getBoundingClientRect().width > 0 && el.textContent?.trim()?.length > 3) {
          results.push({type:'open', tag: el.tagName, text: el.textContent?.trim()?.substring(0,200)});
        }
      });
      // role menu/listbox
      document.querySelectorAll('[role="menu"], [role="listbox"], [role="radiogroup"]').forEach(el => {
        if (el.getBoundingClientRect().width > 0) results.push({type:'menu', text: el.textContent?.trim()?.substring(0,300)});
      });
      return results;
    })())
  `);
  console.log('Dropdown content:', dropdown);

  // Close dropdown
  await evalJS(ws, 'document.body.click()');
  await new Promise(r => setTimeout(r, 1000));

  // ===== STEP 5: Test aspect ratio =====
  log(5, 'Testing aspect ratio button');
  const arClick = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('crop_') && !t.includes('Nano') && !t.includes('Veo') && b.getBoundingClientRect().width > 0) {
          b.click();
          return 'Clicked: ' + t;
        }
      }
      return 'Not found (may be combined button)';
    })()
  `);
  console.log(arClick);
  await new Promise(r => setTimeout(r, 1500));
  await evalJS(ws, 'document.body.click()');
  await new Promise(r => setTimeout(r, 500));

  // ===== STEP 6: Test output count =====
  log(6, 'Testing output count button');
  const countClick = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.match(/^x[0-9]/) && b.getBoundingClientRect().width > 0) {
          b.click();
          return 'Clicked: ' + t;
        }
      }
      return 'Not found (may be combined button)';
    })()
  `);
  console.log(countClick);
  await new Promise(r => setTimeout(r, 1500));
  await evalJS(ws, 'document.body.click()');
  await new Promise(r => setTimeout(r, 500));

  // ===== STEP 7: Type prompt =====
  log(7, 'Typing prompt');
  const promptResult = await evalJS(ws, `
    (function(){
      const ce = document.querySelector("div[contenteditable='true']");
      if (!ce) return 'ERROR: No contenteditable found';
      ce.click();
      ce.focus();
      // Select all existing text
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ce);
      sel.removeAllRanges();
      sel.addRange(range);
      // Set text
      document.execCommand('insertText', false, '${TEST_PROMPT}');
      return 'OK: typed prompt, length=' + ce.textContent.length;
    })()
  `);
  console.log(promptResult);
  await new Promise(r => setTimeout(r, 1000));

  // ===== STEP 8: Find Create button =====
  log(8, 'Finding Create button');
  const createBtn = await evalJS(ws, `
    (function(){
      const buttons = document.querySelectorAll('button, [role="button"]');
      const found = [];
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        if (text.includes('Create') && btn.getBoundingClientRect().width > 0) {
          found.push({
            text: text.substring(0, 60),
            hasArrow: text.includes('arrow_forward'),
            hasAdd: text.includes('add_2'),
            disabled: btn.disabled,
            w: Math.round(btn.getBoundingClientRect().width)
          });
        }
      }
      return JSON.stringify(found);
    })()
  `);
  console.log('Create buttons found:', createBtn);

  // ===== STEP 9: Count existing media items =====
  log(9, 'Counting existing media items');
  const initialCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);
  console.log('Initial media count:', initialCount);

  // ===== STEP 10: Click submit Create (arrow_forward) =====
  log(10, 'Clicking submit Create button');
  const submitResult = await evalJS(ws, `
    (function(){
      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        if (text.includes('Create') && text.includes('arrow_forward') && btn.getBoundingClientRect().width > 0) {
          btn.click();
          return 'CLICKED: submit Create button';
        }
      }
      return 'NOT_FOUND: no arrow_forward Create button';
    })()
  `);
  console.log(submitResult);

  if (submitResult.startsWith('NOT_FOUND')) {
    console.log('\nTest stopped: Could not find submit button.');
    console.log('Make sure the prompt input has text and the Create button is visible.');
    ws.close();
    return;
  }

  // ===== STEP 11: Wait for generation =====
  log(11, 'Waiting for generation (polling every 10s, max 5min)');
  const startTime = Date.now();
  const maxWait = 5 * 60 * 1000; // 5 minutes
  let generated = false;

  while (Date.now() - startTime < maxWait) {
    await new Promise(r => setTimeout(r, 10000));
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Check for video element
    const hasVideo = await evalJS(ws, `
      (function(){
        const videos = document.querySelectorAll('video');
        for (const v of videos) {
          if (v.src || v.currentSrc) return true;
        }
        return false;
      })()
    `);

    // Check media count
    const currentCount = await evalJS(ws, `document.querySelectorAll('[id^="fe_id_"]').length`);

    // Check for errors
    const errText = await evalJS(ws, `
      (function(){
        const errs = document.querySelectorAll('[class*="error"], [role="alert"]');
        for (const el of errs) {
          const t = el.textContent?.trim();
          if (t && t.length > 5 && !t.includes('recaptcha')) return t.substring(0, 200);
        }
        return '';
      })()
    `);

    console.log(`  [${elapsed}s] videos=${hasVideo}, mediaItems=${currentCount} (was ${initialCount}), error=${errText || 'none'}`);

    if (errText && !errText.includes("doesn't seem")) {
      console.error('GENERATION ERROR:', errText);
      break;
    }

    if (hasVideo || currentCount > initialCount) {
      console.log('  Generation complete!');
      generated = true;
      break;
    }
  }

  if (!generated) {
    console.log('Generation did not complete within timeout');
    ws.close();
    return;
  }

  // ===== STEP 12: Check generated media =====
  log(12, 'Checking generated media');
  await new Promise(r => setTimeout(r, 3000));

  const mediaItems = await evalJS(ws, `
    JSON.stringify(
      Array.from(document.querySelectorAll('[id^="fe_id_"]')).map(el => ({
        id: el.id,
        href: el.querySelector('a')?.href || ''
      }))
    )
  `);
  console.log('Media items:', mediaItems);

  // ===== STEP 13: Open last media detail =====
  log(13, 'Opening latest media detail');
  const openResult = await evalJS(ws, `
    (function(){
      const items = document.querySelectorAll('[id^="fe_id_"]');
      if (items.length === 0) return 'No items';
      const last = items[items.length - 1];
      const link = last.querySelector('a');
      if (link) { link.click(); return 'Clicked: ' + link.href; }
      last.click();
      return 'Clicked item directly';
    })()
  `);
  console.log(openResult);
  await new Promise(r => setTimeout(r, 5000));

  // ===== STEP 14: Check video source =====
  log(14, 'Extracting video source');
  const videoSrc = await evalJS(ws, `
    (function(){
      const videos = document.querySelectorAll('video');
      const real = Array.from(videos).filter(v => {
        const src = v.src || v.currentSrc || '';
        return src && !src.includes('gstatic.com');
      });
      if (real.length === 0) return 'No real video found';
      const v = real[real.length - 1];
      return (v.src || v.currentSrc || '').substring(0, 300);
    })()
  `);
  console.log('Video src:', videoSrc);

  // ===== STEP 15: Check Download button =====
  log(15, 'Checking Download button');
  const dlBtn = await evalJS(ws, `
    (function(){
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (t.includes('Download') && b.getBoundingClientRect().width > 0) {
          return 'FOUND: Download button - ' + t.substring(0, 60);
        }
      }
      return 'NOT_FOUND';
    })()
  `);
  console.log(dlBtn);

  // ===== SUMMARY =====
  console.log('\n' + '='.repeat(50));
  console.log('E2E TEST SUMMARY');
  console.log('='.repeat(50));
  console.log(`Login: ${loggedIn.startsWith('LOGGED_IN') ? 'OK' : 'FAIL'}`);
  console.log(`Settings buttons: ${settings ? 'OK' : 'NONE'}`);
  console.log(`Prompt input: ${promptResult.startsWith('OK') ? 'OK' : 'FAIL'}`);
  console.log(`Submit button: ${submitResult.startsWith('CLICKED') ? 'OK' : 'FAIL'}`);
  console.log(`Generation: ${generated ? 'OK' : 'FAIL/TIMEOUT'}`);
  console.log(`Video source: ${videoSrc.startsWith('http') || videoSrc.startsWith('blob:') ? 'OK' : videoSrc}`);
  console.log(`Download button: ${dlBtn.startsWith('FOUND') ? 'OK' : 'NOT FOUND'}`);
  console.log('='.repeat(50));

  ws.close();
  console.log('\nDone.');
}

main().catch(console.error);
