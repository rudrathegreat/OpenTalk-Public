const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const smokeRoot = path.resolve(__dirname, `../.runtime/opentalk-overlay-smoke-${randomUUID()}`);
app.setPath('appData', smokeRoot);
app.setPath('userData', path.join(smokeRoot, 'Electron'));
require('../apps/desktop/dist/main.cjs');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const timeout = setTimeout(() => { console.error('OpenTalk overlay visibility smoke timed out.'); app.exit(1); }, 20_000);

app.whenReady().then(async () => {
  try {
    let hub;
    let overlay;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const windows = BrowserWindow.getAllWindows();
      hub = windows.find(window => window.webContents.getURL() === 'opentalk://app/index.html');
      overlay = windows.find(window => window.webContents.getURL().includes('overlay=1'));
      if (hub && overlay && !hub.webContents.isLoading() && !overlay.webContents.isLoading()) break;
      await pause(50);
    }
    assert.ok(hub, 'Hub window did not load.');
    assert.ok(overlay, 'Recording overlay did not load.');
    assert.equal(overlay.isVisible(), true, 'The bounded launch hint should initially be visible.');

    const saveVisibility = value => hub.webContents.executeJavaScript(`(async()=>{const current=await window.openTalk.getSnapshot();const updated=await window.openTalk.updateSettings({...current.settings,keepOverlayVisible:${value}});return updated.settings.keepOverlayVisible;})()`);
    assert.equal(await saveVisibility(false), false);
    await pause(100);
    assert.equal(overlay.isVisible(), false, 'Saving the off choice should immediately hide the idle overlay.');

    assert.equal(await saveVisibility(true), true);
    await pause(100);
    assert.equal(overlay.isVisible(), true, 'Saving the on choice should show the idle overlay.');

    assert.equal(await saveVisibility(false), false);
    await pause(100);
    assert.equal(overlay.isVisible(), false, 'Saving the off choice again should hide the idle overlay.');

    console.log(JSON.stringify({ result: 'PASS', launchHintVisible: true, hiddenAfterOffSave: true, visibleAfterOnSave: true, hiddenAfterSecondOffSave: true }));
    clearTimeout(timeout);
    app.quit();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    clearTimeout(timeout);
    app.exit(1);
  }
});
