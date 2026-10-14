const { app, safeStorage } = require('electron');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

app.setName('OpenTalk W03 State Check');
const data = join(app.getPath('appData'), 'OpenTalk');
app.setPath('userData', data);

app.whenReady().then(async () => {
  const file = join(data, 'accounts.enc');
  const encrypted = await readFile(file);
  if (!safeStorage.isEncryptionAvailable()) throw new Error('protected storage unavailable');
  const state = JSON.parse(safeStorage.decryptString(encrypted));
  const profiles = Array.isArray(state.profiles) ? state.profiles : [];
  const result = {
    result: 'PASS',
    encryptedAtRest: encrypted[0] !== 0x7b,
    profileCount: profiles.length,
    issuedRegistrations: profiles.filter(profile => typeof profile?.clientId === 'string' && profile.clientId.length > 0).length,
    validatedIdentities: profiles.filter(profile => typeof profile?.subject === 'string' && profile.subject.length > 0).length,
    protectedCredentialRecords: profiles.filter(profile => profile?.credentials && typeof profile.credentials === 'object').length,
    selectedRegistration: typeof state.selectedId === 'string',
  };
  console.log(JSON.stringify(result));
  app.quit();
}).catch(error => {
  console.error(error instanceof Error ? error.message : 'state check failed');
  app.exit(1);
});
