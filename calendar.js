/**
 * MindLink - Auth Module
 * PINコード認証の管理
 */

const MindLinkAuth = (() => {
  let _currentPin = null;      // セッション中のPINをメモリに保持
  let _lockTimer = null;
  let _isLocked = false;

  // 現在のPIN（APIキー復号化用）
  function getCurrentPin() { return _currentPin; }

  // ── 初回セットアップ ──
  async function setupPin(pin) {
    const salt = MindLinkCrypto.generateSalt();
    const hash = await MindLinkCrypto.sha256(pin + salt);
    MindLinkStorage.setAuth({ pinHash: hash, salt });
    _currentPin = pin;
    return true;
  }

  // ── PIN検証 ──
  async function verifyPin(pin) {
    const auth = MindLinkStorage.getAuth();
    if (!auth) return false;
    const hash = await MindLinkCrypto.sha256(pin + auth.salt);
    if (hash === auth.pinHash) {
      _currentPin = pin;
      return true;
    }
    return false;
  }

  // ── PIN変更 ──
  async function changePin(currentPin, newPin) {
    const valid = await verifyPin(currentPin);
    if (!valid) return { success: false, error: '現在のPINが違います' };
    if (newPin.length < 4) return { success: false, error: 'PINは4桁以上必要です' };

    const settings = MindLinkStorage.getSettings();
    const auth = MindLinkStorage.getAuth();
    const newSalt = MindLinkCrypto.generateSalt();
    const newHash = await MindLinkCrypto.sha256(newPin + newSalt);
    
    const updates = {};
    
    // 既存のAPIキー（Gemini）を再暗号化
    if (settings.encryptedApiKey) {
      const apiKey = await MindLinkCrypto.decrypt(settings.encryptedApiKey, currentPin, auth.salt);
      if (apiKey) {
        updates.encryptedApiKey = await MindLinkCrypto.encrypt(apiKey, newPin, newSalt);
      }
    }
    
    // 既存のAPIキー（Google Services）を再暗号化
    if (settings.encryptedGoogleServicesApiKey) {
      const serviceKey = await MindLinkCrypto.decrypt(settings.encryptedGoogleServicesApiKey, currentPin, auth.salt);
      if (serviceKey) {
        updates.encryptedGoogleServicesApiKey = await MindLinkCrypto.encrypt(serviceKey, newPin, newSalt);
      }
    }

    MindLinkStorage.setAuth({ pinHash: newHash, salt: newSalt });
    if (Object.keys(updates).length > 0) {
      MindLinkStorage.updateSettings(updates);
    }

    _currentPin = newPin;
    return { success: true };
  }

  // ── APIキー保存（暗号化） ──
  async function saveApiKey(apiKey, type = 'gemini') {
    const auth = MindLinkStorage.getAuth();
    if (!auth || !_currentPin) return false;
    const encrypted = await MindLinkCrypto.encrypt(apiKey, _currentPin, auth.salt);
    
    const field = type === 'google_services' ? 'encryptedGoogleServicesApiKey' : 'encryptedApiKey';
    MindLinkStorage.updateSettings({ [field]: encrypted });
    return true;
  }

  // ── APIキー取得（復号化） ──
  async function getApiKey(type = 'gemini') {
    const settings = MindLinkStorage.getSettings();
    const auth = MindLinkStorage.getAuth();
    const field = type === 'google_services' ? 'encryptedGoogleServicesApiKey' : 'encryptedApiKey';
    const encryptedKey = settings[field];
    
    if (!encryptedKey || !auth || !_currentPin) return null;
    return await MindLinkCrypto.decrypt(encryptedKey, _currentPin, auth.salt);
  }

  // ── 自動ロック ──
  function startLockTimer() {
    const settings = MindLinkStorage.getSettings();
    const minutes = settings.autoLockMinutes;
    if (!minutes || minutes === 0) return;
    clearLockTimer();
    _lockTimer = setTimeout(() => {
      lockApp();
    }, minutes * 60 * 1000);
  }

  function resetLockTimer() {
    if (_isLocked) return;
    startLockTimer();
  }

  function clearLockTimer() {
    if (_lockTimer) {
      clearTimeout(_lockTimer);
      _lockTimer = null;
    }
  }

  function lockApp() {
    _isLocked = true;
    _currentPin = null;
    clearLockTimer();
    document.getElementById('lock-overlay')?.classList.add('active');
  }

  function unlockApp() {
    _isLocked = false;
    document.getElementById('lock-overlay')?.classList.remove('active');
    startLockTimer();
  }

  function isLocked() { return _isLocked; }

  return {
    getCurrentPin,
    setupPin,
    verifyPin,
    changePin,
    saveApiKey,
    getApiKey,
    startLockTimer,
    resetLockTimer,
    clearLockTimer,
    lockApp,
    unlockApp,
    isLocked,
  };
})();

window.MindLinkAuth = MindLinkAuth;
