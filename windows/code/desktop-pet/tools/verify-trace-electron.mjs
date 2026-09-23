/**
 * tools/verify-trace-electron.mjs
 * Automated browser acceptance script for Trace management page via Electron Chromium.
 *
 * Verifies live management console:
 * 1. Default UI masking for all cards (16/16 fields across user & reply).
 * 2. KPI metrics rendering (total turns, avg elapsed, success rate, tokens).
 * 3. Foregound & background stage pipelines.
 * 4. On-demand History reading interaction:
 *    - Available trace: reveals text on demand, re-masks when clicking "隐藏正文".
 *    - Unavailable trace: safely displays reason, leaves text masked.
 * 5. Refresh button state resetting.
 * 6. Safe desensitized screenshot capture for acceptance evidence.
 */

import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const tempUserData = mkdtempSync(join(tmpdir(), 'electron-trace-audit-'));
app.setPath('userData', tempUserData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: 1280,
    height: 960,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  let targetUrl = process.argv[2];
  if (!targetUrl) {
    const sessionFile = resolve('../../.local/model-evaluation/trial/user-trial/management-session.json');
    if (existsSync(sessionFile)) {
      const session = JSON.parse(readFileSync(sessionFile, 'utf8'));
      targetUrl = session.url + '&page=events';
    } else {
      console.error('No target URL provided and management-session.json not found.');
      app.exit(1);
      return;
    }
  }

  try {
    console.log(`[Browser Automation] Loading URL: ${targetUrl.replace(/token=[a-f0-9]{64}/, 'token=***')}`);
    await win.loadURL(targetUrl);

    const auditScript = `(async () => {
      const pause = ms => new Promise(res => setTimeout(res, ms));
      const waitFor = async (pred, msg, timeout = 12000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const v = pred();
          if (v) return v;
          await pause(50);
        }
        throw new Error(msg);
      };

      const getCards = () => [...document.querySelectorAll('.trace-card')];
      const getCard = idx => document.querySelectorAll('.trace-card')[idx];

      // 1. Wait for Trace cards to render
      await waitFor(() => document.querySelector('.trace-card'), 'Trace cards did not appear within timeout');
      const initialCards = getCards();

      // 2. Read KPI summary
      const kpis = [...document.querySelectorAll('.trace-kpi-card')].map(card => {
        const label = card.querySelector('.trace-kpi-label')?.textContent?.trim() || '';
        const val = card.querySelector('.trace-kpi-val')?.textContent?.trim() || '';
        return { label, val };
      });

      // 3. Audit each card for default masking
      const DIGEST_PATTERN = /^\\[digest:[0-9a-f]{8} len:\\d+\\]$|^\\[digest:masked len:\\d+\\]$/;
      const cardAudits = [];
      let totalDigestFields = 0;
      let totalTextFields = 0;

      for (let i = 0; i < initialCards.length; i++) {
        const c = initialCards[i];
        const userEl = c.querySelector('.trace-msg-user');
        const asstEl = c.querySelector('.trace-msg-asst');
        const userText = userEl ? userEl.textContent.replace(/^用户：/, '').trim() : '';
        const asstText = asstEl ? asstEl.textContent.replace(/^Aika：/, '').trim() : '';

        totalTextFields += 2;
        const userMasked = DIGEST_PATTERN.test(userText);
        const asstMasked = DIGEST_PATTERN.test(asstText);
        if (userMasked) totalDigestFields++;
        if (asstMasked) totalDigestFields++;

        const actionButtons = [...c.querySelectorAll('.actions button')];
        const revealBtn = actionButtons.find(b => /查看本机历史正文|隐藏正文/.test(b.textContent));

        cardAudits.push({
          cardIndex: i + 1,
          userMasked,
          asstMasked,
          hasRevealButton: !!revealBtn,
          revealButtonText: revealBtn?.textContent?.trim() || null,
          hasFgTrack: !!c.querySelector('.fg-track'),
          hasBgTrack: !!c.querySelector('.bg-track'),
          hasDetailsToggle: !!c.querySelector('.trace-details-toggle'),
        });
      }

      // 4. Test interaction: click "查看本机历史正文" on Card 1 (which has available history)
      let availableCardInteraction = { tested: false };
      const card1 = getCard(0);
      const btn1 = card1 ? [...card1.querySelectorAll('.actions button')].find(b => b.textContent.includes('查看本机历史正文')) : null;

      if (btn1) {
        btn1.click();
        // Wait for button to change to "隐藏正文"
        await waitFor(() => {
          const card = getCard(0);
          if (!card) return false;
          const btn = [...card.querySelectorAll('.actions button')].find(b => b.textContent.includes('隐藏正文'));
          return !!btn;
        }, 'Card 1 on-demand reveal did not complete');

        const cardAfterReveal = getCard(0);
        const userAfterReveal = cardAfterReveal.querySelector('.trace-msg-user')?.textContent?.replace(/^用户：/, '').trim() || '';
        const isRevealed = userAfterReveal.length > 0 && !DIGEST_PATTERN.test(userAfterReveal);

        // Click "隐藏正文" to re-mask
        const hideBtn = [...cardAfterReveal.querySelectorAll('.actions button')].find(b => b.textContent.includes('隐藏正文'));
        hideBtn.click();

        await waitFor(() => {
          const card = getCard(0);
          if (!card) return false;
          const btn = [...card.querySelectorAll('.actions button')].find(b => b.textContent.includes('查看本机历史正文'));
          const uText = card.querySelector('.trace-msg-user')?.textContent?.replace(/^用户：/, '').trim() || '';
          return btn && DIGEST_PATTERN.test(uText);
        }, 'Card 1 re-masking failed after clicking 隐藏正文');

        availableCardInteraction = {
          tested: true,
          revealedSuccessfully: isRevealed,
          remaskedSuccessfully: true,
        };
      }

      // 5. Test interaction on Card 3 (which has unavailable history because the turn failed)
      let unavailableCardInteraction = { tested: false };
      const card3 = getCard(2); // Card 3 (index 2)
      const btn3 = card3 ? [...card3.querySelectorAll('.actions button')].find(b => b.textContent.includes('查看本机历史正文')) : null;

      if (btn3) {
        btn3.click();
        await waitFor(() => {
          const card = getCard(2);
          if (!card) return false;
          const hint = card.querySelector('.actions small.subtle');
          return hint && hint.textContent.length > 0;
        }, 'Card 3 unavailable hint did not appear');

        const cardAfter = getCard(2);
        const hintText = cardAfter.querySelector('.actions small.subtle')?.textContent?.trim() || '';
        const userText = cardAfter.querySelector('.trace-msg-user')?.textContent?.replace(/^用户：/, '').trim() || '';
        const stillMasked = DIGEST_PATTERN.test(userText);

        unavailableCardInteraction = {
          tested: true,
          hintReceived: hintText,
          stillMasked,
        };
      }

      // 6. Test toolbar refresh button
      const refreshBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('刷新 Trace'));
      let refreshWorks = false;
      if (refreshBtn) {
        refreshBtn.click();
        await waitFor(() => document.querySelector('.trace-card'), 'Trace cards did not reappear after refresh');
        const afterRefreshCards = getCards();
        let allMasked = true;
        for (const c of afterRefreshCards) {
          const uText = c.querySelector('.trace-msg-user')?.textContent?.replace(/^用户：/, '').trim() || '';
          const aText = c.querySelector('.trace-msg-asst')?.textContent?.replace(/^Aika：/, '').trim() || '';
          if (!DIGEST_PATTERN.test(uText) || !DIGEST_PATTERN.test(aText)) {
            allMasked = false;
            break;
          }
        }
        refreshWorks = afterRefreshCards.length === initialCards.length && allMasked;
      }

      return {
        totalCards: initialCards.length,
        kpis,
        totalTextFields,
        totalDigestFields,
        allMaskedByDefault: totalDigestFields === totalTextFields,
        cardAudits,
        availableCardInteraction,
        unavailableCardInteraction,
        refreshWorks,
      };
    })()`;

    const report = await win.webContents.executeJavaScript(auditScript);
    console.log('BROWSER_AUDIT_REPORT=' + JSON.stringify(report, null, 2));

    // Capture screenshot in fully masked default state
    const screenshot = await win.webContents.capturePage();
    const screenshotPath = resolve('../../../docs/next/0.79/evidence/acceptance-20260923/17-browser-automated-trace-acceptance.png');
    writeFileSync(screenshotPath, screenshot.toPNG());
    console.log(`[Browser Automation] Screenshot saved to: ${screenshotPath}`);

  } catch (err) {
    console.error('[Browser Automation Error]:', err);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
    try { rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  }
});
