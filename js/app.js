/**
 * MindLink - App Module
 * メインアプリケーションコントローラー
 */

const MindLinkApp = (() => {
  let _toastTimeout = null;
  let _setupPhase = 1;
  let _setupPin = '';
  let _setupPinConfirm = '';
  let _authPin = '';
  let _authAttempts = 0;
  let _autonomousTimer = null;

  // ── 初期化 ──
  async function init() {
    MindLinkChat.setupMarkdown();
    applyTheme();
    applyColorTheme();
    applyFontSize(); // 保存済みフォントサイズをアプリ起動直後に即時適用
    initThemeWatcher();
    initEventListeners();
    MindLinkChat.initFileEvents();
    if (window.MindLinkCamera) MindLinkCamera.init();
    MindLinkReflection.initListeners();

    // ── OAuth コールバック振り分け ──
    // Spotify は state が 'spotify_' で始まる。Google と干渉しないよう先に処理する。
    const _urlParams    = new URLSearchParams(window.location.search);
    const _cbCode       = _urlParams.get('code');
    const _cbState      = _urlParams.get('state') || '';

    if (_cbCode && _cbState.startsWith('spotify_')) {
      // Spotify コールバック: URLを先にクリーンアップしてから処理
      window.history.replaceState({}, document.title, MindLinkConfig.REDIRECT_URI);
      if (window.MindLinkSpotifyAuth) {
        await MindLinkSpotifyAuth.handleCallback(_cbCode, _cbState);
      }
    }

    // Google OAuth の checkInitialStatus は Spotify 処理後に呼ぶ
    // （URLにcodeが残っていないので干渉しない）
    MindLinkGoogleAuth.checkInitialStatus();

    // Spotify 初期ステータス確認（ログイン済みならポーリング開始）
    if (window.MindLinkSpotifyAuth) {
      await MindLinkSpotifyAuth.checkInitialStatus();
    }

    if (MindLinkStorage.isFirstRun()) {
      showSetupScreen();
    } else {
      showAuthScreen();
    }
    setupAutonomousTimer();
    setupVisibilityHandler();

    // 起動時データ整合性チェック（検知・ログ・診断バナーのみ／削除はしない）
    Diagnostics.runStartupCheck();
  }

  // 保存済みフォントサイズをDOMに適用
  function applyFontSize() {
    const settings = MindLinkStorage.getSettings();
    const size = parseInt(settings.fontSize) || 14;
    document.documentElement.style.fontSize = size + 'px';
    document.documentElement.style.setProperty('--base-font-size', size + 'px');
  }

  // ── 自律発話タイマー ──
  function setupAutonomousTimer() {
    if (_autonomousTimer) clearTimeout(_autonomousTimer);
    
    // 最後にメッセージを交わしてからどれくらい経過したか確認
    const threadId = MindLinkThreads.getCurrentThreadId();
    const messages = MindLinkStorage.getMessages(threadId);
    let elapsedMs = 0;
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      elapsedMs = Date.now() - (lastMsg.timestamp || Date.now());
    }

    // 24時間以上経過している場合は、再会メッセージとして短時間（10秒）で発動
    if (elapsedMs > 24 * 60 * 60 * 1000) {
      console.log('[MindLink] Welcome back: Last message was over 24 hours ago. Triggering soon.');
      _autonomousTimer = setTimeout(() => {
        if (window.MindLinkChat && !MindLinkAuth.isLocked() && !MindLinkChat.isStreaming()) {
          window.MindLinkChat.sendAutonomousMessage(null, elapsedMs);
        }
        setupAutonomousTimer();
      }, 10000);
      return;
    }

    // 2〜5分のランダムな時間を設定 (相棒として自然な頻度)
    const randomTime = Math.floor((2 + Math.random() * 3) * 60 * 1000);
    
    console.log(`[MindLink] Next autonomous trigger in ${Math.round(randomTime / 60000)} mins.`);

    _autonomousTimer = setTimeout(() => {
      if (!MindLinkAuth.isLocked() && !MindLinkChat.isStreaming()) {
        MindLinkChat.sendAutonomousMessage(null, elapsedMs);
      }
      setupAutonomousTimer();
    }, randomTime);
  }

  function resetAutonomousTimer() {
    setupAutonomousTimer();
  }

  // ── PWA復帰検知 (visibilitychange) ──
  function setupVisibilityHandler() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        console.log('[MindLink] App became visible. Re-evaluating autonomous timer.');
        // タイマーをリセットし、経過時間を再評価させる
        setupAutonomousTimer();
      }
    });
  }

  // ── 画面管理 ──

  // 画像リサイズ共通処理
  function resizeImageToBase64(file, maxWidth = 256, maxHeight = 256) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;
          if (width > height) {
            if (width > maxWidth) {
              height = Math.round((height * maxWidth) / width);
              width = maxWidth;
            }
          } else {
            if (height > maxHeight) {
              width = Math.round((width * maxHeight) / height);
              height = maxHeight;
            }
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  function showAuthScreen() {
    const authScreen = document.getElementById('auth-screen');
    const setupScreen = document.getElementById('setup-screen');
    const appEl = document.getElementById('app');
    if (authScreen) { authScreen.classList.add('active'); authScreen.style.display = ''; }
    if (setupScreen) { setupScreen.classList.remove('active'); setupScreen.style.display = 'none'; }
    if (appEl) { appEl.classList.remove('active'); appEl.style.opacity = ''; appEl.style.pointerEvents = ''; }
    resetAuthPin();
  }

  function showSetupScreen() {
    const authScreen = document.getElementById('auth-screen');
    const setupScreen = document.getElementById('setup-screen');
    const appEl = document.getElementById('app');
    if (authScreen) { authScreen.classList.remove('active'); authScreen.style.display = 'none'; }
    if (setupScreen) { setupScreen.classList.add('active'); setupScreen.style.display = ''; }
    if (appEl) { appEl.classList.remove('active'); appEl.style.opacity = ''; appEl.style.pointerEvents = ''; }
    _setupPhase = 1;
    _setupPin = '';
    _setupPinConfirm = '';
    showSetupStep(1);
  }

  function showApp() {
    const authScreen = document.getElementById('auth-screen');
    const setupScreen = document.getElementById('setup-screen');
    const appEl = document.getElementById('app');
    if (authScreen) { authScreen.classList.remove('active'); authScreen.style.display = 'none'; }
    if (setupScreen) { setupScreen.classList.remove('active'); setupScreen.style.display = 'none'; }
    if (appEl) { appEl.classList.add('active'); appEl.style.opacity = '1'; appEl.style.pointerEvents = 'all'; }
    MindLinkAuth.startLockTimer();
    initAppUI();
    // PIN解除後に自律発話タイマーを再評価（1時間経過チェック含む）
    resetAutonomousTimer();
    // localStorageに残るアーカイブ済みスレッドをIndexedDB倉庫へ移行（確認ポップアップ付き）
    setTimeout(() => migrateArchivedThreadsToIDB(), 800);
  }

  // アーカイブ済みスレッドの会話本文を localStorage → IndexedDB倉庫 へ移行する。
  // データが消える瞬間が無いよう「IDBに書く→検証→localStorage削除」の順で行う。
  async function migrateArchivedThreadsToIDB() {
    let ids;
    try {
      ids = MindLinkStorage.getUnmigratedArchivedThreadIds();
    } catch (e) {
      console.error('[MindLink] migration detect failed:', e);
      return;
    }
    if (!ids || ids.length === 0) return;

    showConfirm(
      'データ移行',
      `アーカイブ済みの ${ids.length} 件のスレッドをデータベースに移動して、localStorageの容量を空けます。\n（会話は消えません。アーカイブからこれまで通り閲覧できます）\n実行しますか？`,
      async () => {
        let moved = 0;
        for (const id of ids) {
          try {
            const messages = MindLinkStorage.getMessages(id);
            await MindLinkStorage.idbPutArchivedMessages(id, messages);
            const check = await MindLinkStorage.idbGetArchivedMessages(id);
            if (check === null || check.length !== messages.length) {
              throw new Error('IndexedDBへの書き込み検証に失敗');
            }
            MindLinkStorage.remove('messages_' + id);
            moved++;
          } catch (e) {
            console.error('[MindLink] migrate failed for', id, e);
          }
        }
        showToast(`${moved}件のスレッドを移行しました`);
      }
    );
  }

  function initAppUI() {
    // 既存スレッドがあれば最初のものを選択
    const threads = MindLinkStorage.getThreads().filter(t => !t.isArchived);
    if (threads.length > 0) {
      selectThread(threads[0].id);
    } else {
      MindLinkChat.clearMessages();
    }

    // ペルソナ名表示
    const activePersonaId = MindLinkStorage.getActivePersonaId();
    const persona = MindLinkStorage.getPersona(activePersonaId) || MindLinkStorage.getDefaultPersona();
    MindLinkPersonas.selectPersona(persona?.id);

    MindLinkThreads.renderThreadList();
    initSettingsUI();
  }

  // ── スレッド選択 ──
  async function selectThread(id) {
    MindLinkThreads.setCurrentThreadId(id);
    const thread = MindLinkStorage.getThread(id);
    if (!thread) return;

    document.getElementById('current-thread-title').textContent = thread.title;

    // アーカイブ状態のUI制御
    const inputArea = document.querySelector('.input-area');
    const threadMenuBtn = document.getElementById('btn-thread-menu');
    
    let badge = document.getElementById('archive-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'archive-badge';
      badge.textContent = 'アーカイブ（閲覧専用）';
      badge.style.marginLeft = '10px';
      badge.style.fontSize = '12px';
      badge.style.backgroundColor = 'var(--bg-secondary)';
      badge.style.padding = '2px 8px';
      badge.style.borderRadius = '12px';
      badge.style.border = '1px solid var(--border-color)';
      badge.style.verticalAlign = 'middle';
      const titleEl = document.getElementById('current-thread-title');
      titleEl.insertAdjacentElement('afterend', badge);
    }
    
    if (thread.isArchived) {
      if (inputArea) inputArea.style.display = 'none';
      if (threadMenuBtn) threadMenuBtn.style.display = 'none';
      badge.style.display = 'inline-block';
    } else {
      if (inputArea) inputArea.style.display = '';
      if (threadMenuBtn) threadMenuBtn.style.display = 'inline-flex';
      badge.style.display = 'none';
    }

    // モデルセレクターの更新
    const modelSelect = document.getElementById('thread-model-select');
    if (modelSelect) {
      modelSelect.value = thread.model || 'gemini-3.1-flash-preview';
    }

    MindLinkPersonas.selectPersona(thread.personaId);

    await MindLinkChat.loadMessages(id);
    MindLinkThreads.renderThreadList();

    // モバイルでサイドバーを閉じる
    if (window.innerWidth <= 700) {
      closeSidebar();
    }
  }

  // ── テーマ ──
  function applyTheme() {
    const settings = MindLinkStorage.getSettings();
    const theme = settings.theme || 'system';
    let actualTheme = theme;
    if (theme === 'system') {
      actualTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', actualTheme);

    // hljs テーマ切替
    const hljsLink = document.getElementById('hljs-theme');
    if (hljsLink) {
      hljsLink.href = actualTheme === 'dark'
        ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css'
        : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
    }

    // theme-color meta
    const themeMeta = document.getElementById('theme-color-meta');
    if (themeMeta) {
      themeMeta.content = actualTheme === 'dark' ? '#0a0f1e' : '#fafafa';
    }

    // 設定UIのアクティブ状態
    document.querySelectorAll('.theme-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeOption === theme);
    });

    return actualTheme;
  }

  function applyColorTheme() {
    const settings = MindLinkStorage.getSettings();
    const colorTheme = settings.colorTheme || 'default';
    document.documentElement.setAttribute('data-color-theme', colorTheme);
    document.querySelectorAll('.color-theme-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.colorThemeOption === colorTheme);
    });
  }

  function initThemeWatcher() {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const settings = MindLinkStorage.getSettings();
      if (settings.theme === 'system') applyTheme();
    });
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const newTheme = current === 'dark' ? 'light' : 'dark';
    MindLinkStorage.updateSettings({ theme: newTheme });
    applyTheme();
  }

  // ── モーダル ──
  function openModal(id) {
    document.getElementById(id)?.classList.add('active');
  }
  function closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
  }
  function closeAllModals() {
    document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
  }

  // ── 確認モーダル ──
  function showConfirm(title, message, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-modal-title');
    const messageEl = document.getElementById('confirm-modal-message');
    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');

    if (!modal || !titleEl || !messageEl || !okBtn || !cancelBtn) return;

    titleEl.textContent = title;
    messageEl.innerHTML = message.replace(/\n/g, '<br>');
    modal.classList.add('active');

    // 古いイベントリスナーの削除（クローンによる置換が最も確実）
    const newOkBtn = okBtn.cloneNode(true);
    const newCancelBtn = cancelBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOkBtn, okBtn);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

    newOkBtn.addEventListener('click', () => {
      modal.classList.remove('active');
      if (onConfirm) onConfirm();
    });

    newCancelBtn.addEventListener('click', () => {
      modal.classList.remove('active');
    });
  }

  // ── Toast通知 ──
  function showToast(message) {
    const toast = document.getElementById('toast-notification');
    const textEl = document.getElementById('toast-notification-text');
    if (!toast || !textEl) return;
    textEl.textContent = message;
    toast.classList.add('active');
    if (_toastTimeout) clearTimeout(_toastTimeout);
    _toastTimeout = setTimeout(() => toast.classList.remove('active'), 3000);
  }

  // ── 進捗インジケーター（常駐・完了で消す。省察など時間のかかる処理用） ──
  // showProgress(text) で表示/更新、hideProgress() で消去。何度呼んでも安全（冪等）。
  function showProgress(text) {
    let bar = document.getElementById('app-progress-bar');
    if (!bar) {
      // スピナー回転用のキーフレームを一度だけ注入
      if (!document.getElementById('app-progress-style')) {
        const style = document.createElement('style');
        style.id = 'app-progress-style';
        style.textContent = '@keyframes app-progress-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
        document.head.appendChild(style);
      }
      bar = document.createElement('div');
      bar.id = 'app-progress-bar';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:100000;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:13px;line-height:1.4;padding:8px 12px;display:flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(0,0,0,.3);';
      const spinner = document.createElement('span');
      spinner.textContent = '🌙';
      spinner.style.cssText = 'display:inline-block;animation:app-progress-spin 1.2s linear infinite;';
      const label = document.createElement('span');
      label.id = 'app-progress-text';
      label.style.flex = '1 1 auto';
      bar.append(spinner, label);
      document.body.appendChild(bar);
    }
    const label = document.getElementById('app-progress-text');
    if (label) label.textContent = text;
  }

  function hideProgress() {
    document.getElementById('app-progress-bar')?.remove();
  }

  // ── アーカイブ一括エクスポート（JSONファイルとしてダウンロード） ──
  // 読み取りのみ。既存データは一切変更・削除しない。
  async function exportArchive() {
    const data = await MindLinkStorage.exportArchivedThreads();
    if (!data || data.threadCount === 0) {
      showToast('アーカイブされたスレッドがありません');
      return;
    }
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const today = new Date();
    const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    const filename = `mindlink-archive-${ymd}.json`;

    // 標準ダウンロード（<a download>）
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`${data.threadCount}件のスレッドをエクスポートしました`);
    } catch (e) {
      // iOS PWA フォールバック：新規タブで開いて「共有→ファイルに保存」してもらう
      console.warn('[MindLink] export download fallback:', e);
      try {
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        showToast('開いたページから「共有→ファイルに保存」してください');
      } catch (e2) {
        console.error('[MindLink] export failed:', e2);
        showToast('エクスポートに失敗しました');
      }
    }
  }

  // ── アーカイブ一括インポート ──
  // 取り込んだスレッドは必ずアーカイブ状態で入る（本文はIndexedDB倉庫へ）。
  function importArchive() {
    document.getElementById('input-import-archive')?.click();
  }

  async function handleImportArchiveFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // 同じファイルを再選択できるようリセット
    if (!file) return;

    let data;
    try {
      const text = await file.text();
      data = JSON.parse(text);
    } catch (err) {
      console.error('[MindLink] import read/parse failed:', err);
      showToast('ファイルを読み込めませんでした');
      return;
    }
    if (!data || data.format !== 'mindlink-archive-export' || !Array.isArray(data.threads)) {
      showToast('対応していないファイル形式です');
      return;
    }

    const count = data.threads.length;
    showConfirm(
      'アーカイブを読み込む',
      `このファイルから ${count} 件のスレッドをアーカイブに取り込みます。\n（既に同じスレッドがある場合はスキップされます）\n実行しますか？`,
      async () => {
        try {
          const result = await MindLinkStorage.importArchivedThreads(data);
          MindLinkThreads.renderArchiveList();
          MindLinkThreads.renderThreadList();
          showToast(`${result.imported}件を取り込みました（${result.skipped}件はスキップ）`);
        } catch (err) {
          console.error('[MindLink] import error:', err);
          showToast(err.message || 'インポートに失敗しました');
        }
      }
    );
  }

  // ── サイドバー ──
  function openSidebar() {
    document.getElementById('sidebar')?.classList.add('open');
    document.getElementById('sidebar-backdrop')?.classList.add('active');
  }
  function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-backdrop')?.classList.remove('active');
  }

  // ── 設定UI初期化 ──
  function initSettingsUI() {
    const settings = MindLinkStorage.getSettings();

    // 温度
    const tempSlider = document.getElementById('setting-temperature');
    const tempValue = document.getElementById('setting-temperature-value');
    if (tempSlider) {
      tempSlider.value = settings.temperature;
      if (tempValue) tempValue.textContent = settings.temperature;
      tempSlider.addEventListener('input', () => {
        if (tempValue) tempValue.textContent = parseFloat(tempSlider.value).toFixed(1);
      });
    }

    // 最大トークン
    const tokenSel = document.getElementById('setting-max-tokens');
    if (tokenSel) tokenSel.value = settings.maxTokens;

    // 自動ロック
    const lockSel = document.getElementById('setting-auto-lock');
    if (lockSel) lockSel.value = settings.autoLockMinutes;

    // フォントサイズ
    const fontSlider = document.getElementById('setting-font-size');
    const fontValue = document.getElementById('setting-font-size-value');
    if (fontSlider) {
      fontSlider.value = settings.fontSize;
      if (fontValue) fontValue.textContent = settings.fontSize + 'px';
      // 起動時にCSSへ適用
      document.documentElement.style.fontSize = settings.fontSize + 'px';
      document.documentElement.style.setProperty('--base-font-size', settings.fontSize + 'px');
      fontSlider.addEventListener('input', () => {
        const size = parseInt(fontSlider.value);
        if (fontValue) fontValue.textContent = size + 'px';
        // CSS変数と直接指定を統一して適用
        document.documentElement.style.fontSize = size + 'px';
        document.documentElement.style.setProperty('--base-font-size', size + 'px');
        // スライダー操作中もリアルタイムで保存（アプリ終了時にも残るよう）
        MindLinkStorage.updateSettings({ fontSize: size });
      });
    }

    // テーマオプション
    document.querySelectorAll('.theme-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeOption === settings.theme);
    });

    // カラーテーマオプション
    document.querySelectorAll('.color-theme-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.colorThemeOption === (settings.colorTheme || 'default'));
    });

    // プロフィールタブ
    const uName = document.getElementById('setting-user-name');
    const uBio = document.getElementById('setting-user-bio');
    const uAvatarText = document.getElementById('setting-user-avatar');
    const uAvatarPreview = document.getElementById('user-avatar-preview');
    if (uName) uName.value = settings.userName || 'あなた';
    if (uBio) uBio.value = settings.userBio || '';
    if (settings.userAvatar && settings.userAvatar.startsWith('data:image')) {
      if (uAvatarText) uAvatarText.style.display = 'none';
      if (uAvatarPreview) {
        uAvatarPreview.style.display = 'block';
        uAvatarPreview.style.backgroundImage = `url(${settings.userAvatar})`;
        uAvatarPreview.dataset.base64 = settings.userAvatar;
      }
    } else {
      if (uAvatarText) {
        uAvatarText.style.display = 'block';
        uAvatarText.value = settings.userAvatar || '👤';
      }
      if (uAvatarPreview) {
        uAvatarPreview.style.display = 'none';
        uAvatarPreview.dataset.base64 = '';
      }
    }

    // Google連携タブ
    const gClientId = document.getElementById('setting-google-client-id');
    if (gClientId) gClientId.value = settings.googleClientId || '';
    const gClientSecret = document.getElementById('setting-google-client-secret');
    if (gClientSecret) gClientSecret.value = settings.googleClientSecret || '';
    const gSearchEngineId = document.getElementById('setting-search-engine-id');
    if (gSearchEngineId) gSearchEngineId.value = settings.searchEngineId || '';

    // Spotify連携
    const spotifyClientId = document.getElementById('setting-spotify-client-id');
    if (spotifyClientId) spotifyClientId.value = settings.spotifyClientId || '';
    // Redirect URI の表示
    const spotifyRedirectUri = document.getElementById('spotify-redirect-uri');
    if (spotifyRedirectUri) spotifyRedirectUri.textContent = MindLinkConfig.REDIRECT_URI;

    // 省察モデル
    const summaryModelSel = document.getElementById('setting-summary-model');
    if (summaryModelSel) summaryModelSel.value = settings.summaryModel || 'gemini-3.5-flash';

    // APIキー状態表示
    const apiKeyInput = document.getElementById('settings-api-key');
    if (apiKeyInput) {
      apiKeyInput.placeholder = settings.encryptedApiKey ? '設定済み (変更時のみ入力)' : '未設定';
    }
    const servicesKeyInput = document.getElementById('settings-services-api-key');
    if (servicesKeyInput) {
      servicesKeyInput.placeholder = settings.encryptedGoogleServicesApiKey ? '設定済み (変更時のみ入力)' : '未設定';
    }
  }

  // 設定保存
  function saveSettings() {
    const temperature = parseFloat(document.getElementById('setting-temperature')?.value);
    const maxTokens = parseInt(document.getElementById('setting-max-tokens')?.value);
    const autoLockMinutes = parseInt(document.getElementById('setting-auto-lock')?.value);
    const fontSize = parseInt(document.getElementById('setting-font-size')?.value);
    const summaryModel = document.getElementById('setting-summary-model')?.value;
    const googleClientId = document.getElementById('setting-google-client-id')?.value.trim();
    const googleClientSecret = document.getElementById('setting-google-client-secret')?.value.trim();
    const searchEngineId = document.getElementById('setting-search-engine-id')?.value.trim();
    const spotifyClientId = document.getElementById('setting-spotify-client-id')?.value.trim();

    MindLinkStorage.updateSettings({ temperature, maxTokens, autoLockMinutes, fontSize, summaryModel, googleClientId, googleClientSecret, searchEngineId, spotifyClientId });
    MindLinkAuth.resetLockTimer();
    showToast('設定を保存しました');
  }

  // ── PINキーパッド処理 ──
  function resetAuthPin() {
    _authPin = '';
    updatePinDisplay('pin-display', 0);
    document.getElementById('pin-error').textContent = '';
  }

  function handleAuthPinInput(num) {
    if (_authPin.length >= 4) return;
    _authPin += num;
    updatePinDisplay('pin-display', _authPin.length);
    if (_authPin.length >= 4) {
      setTimeout(() => attemptUnlock(), 100);
    }
  }

  function handleAuthPinDelete() {
    _authPin = _authPin.slice(0, -1);
    updatePinDisplay('pin-display', _authPin.length);
  }

  async function attemptUnlock() {
    const valid = await MindLinkAuth.verifyPin(_authPin);
    if (valid) {
      _authAttempts = 0;
      showApp();
    } else {
      _authAttempts++;
      document.getElementById('pin-error').textContent = `PINが違います（${_authAttempts}回）`;
      shakePinDisplay('pin-display');
      _authPin = '';
      updatePinDisplay('pin-display', 0);
    }
  }

  // セットアップPINキーパッド
  function handleSetupPinInput(num) {
    if (_setupPhase === 1) {
      if (_setupPin.length >= 4) return;
      _setupPin += num;
      updatePinDisplay('setup-pin-display', _setupPin.length);
      if (_setupPin.length >= 4) {
        setTimeout(() => advanceSetupStep(), 100);
      }
    } else if (_setupPhase === 2) {
      if (_setupPinConfirm.length >= 4) return;
      _setupPinConfirm += num;
      updatePinDisplay('setup-pin-display', _setupPinConfirm.length);
      if (_setupPinConfirm.length >= _setupPin.length) {
        setTimeout(() => confirmSetupPin(), 100);
      }
    }
  }

  function handleSetupPinDelete() {
    if (_setupPhase === 1) {
      _setupPin = _setupPin.slice(0, -1);
      updatePinDisplay('setup-pin-display', _setupPin.length);
    } else {
      _setupPinConfirm = _setupPinConfirm.slice(0, -1);
      updatePinDisplay('setup-pin-display', _setupPinConfirm.length);
    }
  }

  function advanceSetupStep() {
    if (_setupPin.length < 4) {
      document.getElementById('setup-pin-error').textContent = '4桁以上のPINを入力してください';
      return;
    }
    // 確認入力フェーズへ
    _setupPhase = 2;
    _setupPinConfirm = '';
    document.querySelector('#step-1 .step-desc').textContent = '確認のため、もう一度PINを入力してください';
    document.querySelector('#step-1 h3').textContent = '① PINコードを確認';
    updatePinDisplay('setup-pin-display', 0);
    document.getElementById('setup-pin-error').textContent = '';
  }

  async function confirmSetupPin() {
    if (_setupPin !== _setupPinConfirm) {
      document.getElementById('setup-pin-error').textContent = 'PINが一致しません。最初からやり直してください';
      shakePinDisplay('setup-pin-display');
      _setupPhase = 1;
      _setupPin = '';
      _setupPinConfirm = '';
      updatePinDisplay('setup-pin-display', 0);
      document.querySelector('#step-1 .step-desc').textContent = '4桁のPINコードを設定してください';
      document.querySelector('#step-1 h3').textContent = '① PINコードを設定';
      return;
    }
    // PIN設定完了 → Step2へ
    await MindLinkAuth.setupPin(_setupPin);
    showSetupStep(2);
  }

  function showSetupStep(step) {
    document.querySelectorAll('.setup-step').forEach(el => el.classList.remove('active'));
    document.getElementById(`step-${step}`)?.classList.add('active');
  }

  async function saveSetupApiKey() {
    const input = document.getElementById('api-key-input');
    const apiKey = input?.value.trim();
    if (!apiKey) {
      showToast('APIキーを入力してください');
      return;
    }
    try {
      const saveResult = await MindLinkAuth.saveApiKey(apiKey);
      console.log('[MindLink] saveApiKey result:', saveResult);
    } catch (e) {
      console.error('[MindLink] saveApiKey error:', e);
    }
    showToast('セットアップ完了！');
    // 少し待ってから画面切替（Toastが見えるように）
    setTimeout(() => showApp(), 500);
  }

  // PIN表示更新
  function updatePinDisplay(displayId, filledCount) {
    const dots = document.querySelectorAll(`#${displayId} .pin-dot`);
    dots.forEach((dot, i) => {
      dot.classList.toggle('filled', i < filledCount);
    });
  }

  function shakePinDisplay(displayId) {
    const display = document.getElementById(displayId);
    display?.querySelectorAll('.pin-dot').forEach(dot => {
      dot.classList.add('shake');
      setTimeout(() => dot.classList.remove('shake'), 500);
    });
  }

  // ロック解除画面
  function handleLockUnlock() {
    _authPin = '';
    _authAttempts = 0;
    updatePinDisplay('pin-display', 0);
    document.getElementById('pin-error').textContent = '';
    document.getElementById('lock-overlay')?.classList.remove('active');
    MindLinkAuth.unlockApp();
    // 認証画面を表示
    showAuthScreen();
  }

  // ── コンテキストメニュー ──
  let _contextMenuThreadId = null;
  const _MENU_TRANSITION_LOCK = 300; // ms
  let _isMenuOpening = false;

  function showContextMenu(e) {
    const menu = document.getElementById('thread-context-menu');
    const overlay = document.getElementById('context-menu-overlay');
    if (!menu || !overlay) return;

    _isMenuOpening = true;
    setTimeout(() => { _isMenuOpening = false; }, _MENU_TRANSITION_LOCK);

    // スレッドIDを取得して保持（メッセージ送信前はnullの可能性がある）
    _contextMenuThreadId = MindLinkThreads.getCurrentThreadId();

    // 画面中央モーダルとして表示
    menu.classList.add('active');
    overlay.classList.add('active');

    // スレッドが存在する場合のみピン状態を反映
    const pinBtn = document.getElementById('ctx-pin');
    if (pinBtn) {
      if (_contextMenuThreadId) {
        const thread = MindLinkStorage.getThread(_contextMenuThreadId);
        pinBtn.textContent = thread?.isPinned ? '📌 ピン留め解除' : '📌 ピン留め';
        pinBtn.style.opacity = '1';
      } else {
        pinBtn.textContent = '📌 ピン留め';
        pinBtn.style.opacity = '0.5';
      }
    }
  }

  function hideContextMenu() {
    if (_isMenuOpening) return;
    document.getElementById('thread-context-menu')?.classList.remove('active');
    document.getElementById('context-menu-overlay')?.classList.remove('active');
  }

  // ── イベントリスナー ──
  function initEventListeners() {
    // ── 認証画面 PIN ──
    document.querySelectorAll('.pin-key[data-num]').forEach(btn => {
      btn.addEventListener('click', () => handleAuthPinInput(btn.dataset.num));
    });
    document.getElementById('pin-delete')?.addEventListener('click', handleAuthPinDelete);

    // ── セットアップ PIN ──
    document.querySelectorAll('.pin-key[data-setup]').forEach(btn => {
      btn.addEventListener('click', () => handleSetupPinInput(btn.dataset.setup));
    });
    document.getElementById('setup-pin-delete')?.addEventListener('click', handleSetupPinDelete);
    document.getElementById('btn-save-api')?.addEventListener('click', saveSetupApiKey);

    // APIキー表示切替
    document.getElementById('toggle-api-key')?.addEventListener('click', () => {
      const input = document.getElementById('api-key-input');
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    });

    // ── アプリ ──

    // サイドバートグル
    document.getElementById('btn-sidebar-toggle')?.addEventListener('click', () => {
      const sidebar = document.getElementById('sidebar');
      if (window.innerWidth <= 700) {
        sidebar?.classList.contains('open') ? closeSidebar() : openSidebar();
      } else {
        sidebar?.classList.toggle('hidden');
      }
    });
    document.getElementById('sidebar-close')?.addEventListener('click', closeSidebar);
    document.getElementById('sidebar-backdrop')?.addEventListener('click', closeSidebar);

    // 新規スレッド
    document.getElementById('btn-new-thread')?.addEventListener('click', () => {
      const thread = MindLinkThreads.createThread();
      MindLinkThreads.setCurrentThreadId(thread.id);
      MindLinkChat.clearMessages();
      document.getElementById('current-thread-title').textContent = '新しいチャット';
      // モデルセレクトの表示を新スレッドの実モデル（=保留中の選択）に同期
      const _ms = document.getElementById('thread-model-select');
      if (_ms) _ms.value = thread.model;
      MindLinkPersonas.selectPersona(thread.personaId);
      MindLinkThreads.renderThreadList();
      if (window.innerWidth <= 700) closeSidebar();
    });

    // スレッド検索
    document.getElementById('thread-search')?.addEventListener('input', (e) => {
      MindLinkThreads.renderThreadList(e.target.value);
    });

    // テーマトグル
    document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

    // メッセージ入力
    const msgInput = document.getElementById('message-input');
    if (msgInput) {
      // 入力エリアの調整（改行のみ許可）
      msgInput.addEventListener('input', () => {
        MindLinkChat.autoResizeInput();
        MindLinkChat.updateCharCount();
        if (!window.MindLinkChat?.isStreaming()) {
          document.getElementById('btn-send').disabled = msgInput.value.trim().length === 0;
        }
        MindLinkAuth.resetLockTimer();
        resetAutonomousTimer();
      });
    }

    // 送信・停止ボタン
    document.getElementById('btn-send')?.addEventListener('click', () => {
      if (window.MindLinkChat?.isStreaming()) {
        window.MindLinkChat.stopStreaming();
      } else {
        MindLinkChat.sendMessage();
        resetAutonomousTimer();
      }
    });

    // 記憶追加ボタン（入力エリア）
    document.getElementById('btn-add-memory-from-input')?.addEventListener('click', () => {
      document.getElementById('new-memory-content').value = '';
      document.getElementById('new-memory-category').value = 'other';
      document.getElementById('new-memory-tags').value = '';
      openModal('add-memory-modal');
    });

    // 改行ボタン（モバイル用）
    document.getElementById('btn-add-line')?.addEventListener('click', () => {
      const msgInput = document.getElementById('message-input');
      if (!msgInput) return;
      
      const start = msgInput.selectionStart;
      const end = msgInput.selectionEnd;
      const val = msgInput.value;
      
      // カーソル位置に改行を挿入
      msgInput.value = val.substring(0, start) + "\n" + val.substring(end);
      
      // カーソル位置を改行の直後に移動
      msgInput.selectionStart = msgInput.selectionEnd = start + 1;
      
      // 各種更新処理
      msgInput.dispatchEvent(new Event('input'));
      msgInput.focus();
    });

    // ── フッターボタン ──
    document.getElementById('btn-settings')?.addEventListener('click', () => {
      initSettingsUI();
      openModal('settings-modal');
    });
    document.getElementById('btn-memory')?.addEventListener('click', () => {
      MindLinkMemory.renderMemoryList('all');
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === 'all'));
      openModal('memory-modal');
    });
    document.getElementById('btn-personas')?.addEventListener('click', () => {
      MindLinkPersonas.renderPersonaList();
      openModal('persona-modal');
    });
    document.getElementById('btn-archive')?.addEventListener('click', () => {
      MindLinkThreads.renderArchiveList();
      openModal('archive-modal');
    });
    document.getElementById('btn-reflection-note')?.addEventListener('click', async () => {
      await MindLinkReflection.renderReflectionList();
      openModal('reflection-modal');
    });

    // ── 省察モーダル内のイベント ──
    document.getElementById('btn-run-reflection-manual')?.addEventListener('click', () => {
      MindLinkReflection.performReflection(true);
    });
    document.getElementById('btn-update-reflection-save')?.addEventListener('click', () => {
      MindLinkReflection.updateReflection();
    });

    // ── モーダル閉じる ──
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.modal;
        if (id) closeModal(id);
        else btn.closest('.modal-overlay')?.classList.remove('active');
      });
    });
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('active');
      });
    });

    // ── スレッド内モデル選択 ──
    const modelSelectEl = document.getElementById('thread-model-select');
    if (modelSelectEl) {
      // 起動時：保留中（UIで最後に選んだ）モデルを表示に反映し、実モデルと一致させる
      modelSelectEl.value = MindLinkThreads.getPendingModel();
      modelSelectEl.addEventListener('change', (e) => {
        const model = e.target.value;
        // スレッド未作成でも選択を保持（createThread時にこの値が使われる）
        MindLinkThreads.setPendingModel(model);
        const threadId = MindLinkThreads.getCurrentThreadId();
        if (threadId) MindLinkThreads.updateThreadModel(threadId, model);
        MindLinkApp.showToast('モデルを更新しました');
      });
    }

    // ── 設定タブ ──
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab)?.classList.add('active');
      });
    });

    // 設定変更イベント（リアルタイム保存）
    ['setting-model', 'setting-temperature', 'setting-max-tokens', 'setting-auto-lock', 'setting-font-size', 'setting-summary-model'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', saveSettings);
    });

    // モーダル全体の保存ボタン
    document.getElementById('btn-save-settings')?.addEventListener('click', saveSettings);

    // テーマオプション
    document.querySelectorAll('.theme-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const theme = btn.dataset.themeOption;
        MindLinkStorage.updateSettings({ theme });
        applyTheme();
        document.querySelectorAll('.theme-option').forEach(b => b.classList.toggle('active', b.dataset.themeOption === theme));
      });
    });

    // カラーテーマオプション
    document.querySelectorAll('.color-theme-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const colorTheme = btn.dataset.colorThemeOption;
        MindLinkStorage.updateSettings({ colorTheme });
        applyColorTheme();
      });
    });

    // プロフィール設定
    document.getElementById('user-avatar-file')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const base64 = await resizeImageToBase64(file, 200, 200);
        const uAvatarText = document.getElementById('setting-user-avatar');
        const uAvatarPreview = document.getElementById('user-avatar-preview');
        if (uAvatarText) uAvatarText.style.display = 'none';
        if (uAvatarPreview) {
          uAvatarPreview.style.display = 'block';
          uAvatarPreview.style.backgroundImage = `url(${base64})`;
          uAvatarPreview.dataset.base64 = base64;
        }
      } catch (err) {
        showToast('画像の読み込みに失敗しました');
      }
      e.target.value = '';
    });
    
    document.getElementById('btn-clear-user-avatar')?.addEventListener('click', () => {
      const uAvatarText = document.getElementById('setting-user-avatar');
      const uAvatarPreview = document.getElementById('user-avatar-preview');
      if (uAvatarText) {
        uAvatarText.style.display = 'block';
        uAvatarText.value = '';
      }
      if (uAvatarPreview) {
        uAvatarPreview.style.display = 'none';
        uAvatarPreview.dataset.base64 = '';
      }
    });

    document.getElementById('btn-save-profile')?.addEventListener('click', () => {
      const userName = document.getElementById('setting-user-name')?.value.trim() || 'あなた';
      const userBio = document.getElementById('setting-user-bio')?.value.trim() || '';
      
      const uAvatarPreview = document.getElementById('user-avatar-preview');
      const uAvatarText = document.getElementById('setting-user-avatar');
      
      let userAvatar = '👤';
      if (uAvatarPreview && uAvatarPreview.style.display === 'block' && uAvatarPreview.dataset.base64) {
        userAvatar = uAvatarPreview.dataset.base64;
      } else if (uAvatarText && uAvatarText.value) {
        userAvatar = uAvatarText.value;
      }

      MindLinkStorage.updateSettings({ userName, userAvatar, userBio });
      showToast('プロフィールを保存しました');
      MindLinkThreads.renderThreadList(); // UI更新
      selectThread(MindLinkThreads.getCurrentThreadId()); // Reload msg view if needed
    });

    // Gemini APIキー更新
    document.getElementById('btn-update-api-key')?.addEventListener('click', async () => {
      const input = document.getElementById('settings-api-key');
      const key = input?.value.trim();
      if (!key) { showToast('APIキーを入力してください'); return; }
      await MindLinkAuth.saveApiKey(key, 'gemini');
      input.value = '';
      showToast('Gemini APIキーを更新しました ✏️');
      initSettingsUI();
    });
    document.getElementById('settings-toggle-api-key')?.addEventListener('click', () => {
      const input = document.getElementById('settings-api-key');
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    });

    // Google Services APIキー更新
    document.getElementById('btn-update-services-api-key')?.addEventListener('click', async () => {
      const input = document.getElementById('settings-services-api-key');
      const key = input?.value.trim();
      if (!key) { showToast('APIキーを入力してください'); return; }
      await MindLinkAuth.saveApiKey(key, 'google_services');
      input.value = '';
      showToast('ツール用キーを更新しました 🛠️');
      initSettingsUI();
    });
    document.getElementById('settings-toggle-services-api-key')?.addEventListener('click', () => {
      const input = document.getElementById('settings-services-api-key');
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    });

    // API接続テスト
    document.getElementById('btn-test-api')?.addEventListener('click', async () => {
      const resultEl = document.getElementById('api-test-result');
      if (resultEl) { resultEl.textContent = 'テスト中...'; resultEl.className = 'api-test-result'; }
      const result = await MindLinkAPI.testConnection();
      if (resultEl) {
        resultEl.textContent = result.message;
        resultEl.className = 'api-test-result ' + (result.success ? 'success' : 'error');
      }
    });

    // PIN変更
    document.getElementById('btn-change-pin')?.addEventListener('click', () => openModal('change-pin-modal'));
    document.getElementById('btn-confirm-change-pin')?.addEventListener('click', async () => {
      const current = document.getElementById('current-pin-input')?.value;
      const newPin = document.getElementById('new-pin-input')?.value;
      const confirm = document.getElementById('confirm-pin-input')?.value;
      const errorEl = document.getElementById('change-pin-error');
      
      if (newPin !== confirm) {
        if (errorEl) errorEl.textContent = '新しいPINが一致しません';
        return;
      }
      if (newPin.length < 4) {
        if (errorEl) errorEl.textContent = 'PINは4桁以上必要です';
        return;
      }
      const result = await MindLinkAuth.changePin(current, newPin);
      if (result.success) {
        closeModal('change-pin-modal');
        showToast('PINを変更しました 🔐');
        document.getElementById('current-pin-input').value = '';
        document.getElementById('new-pin-input').value = '';
        document.getElementById('confirm-pin-input').value = '';
        if (errorEl) errorEl.textContent = '';
      } else {
        if (errorEl) errorEl.textContent = result.error;
      }
    });

    // アーカイブ一括エクスポート / インポート
    document.getElementById('btn-export-archive')?.addEventListener('click', exportArchive);
    document.getElementById('btn-import-archive')?.addEventListener('click', importArchive);
    document.getElementById('input-import-archive')?.addEventListener('change', handleImportArchiveFile);

    // リセット
    document.getElementById('btn-reset-app')?.addEventListener('click', () => {
      const confirmText = prompt('全データを削除します。確認のため「リセット」と入力してください：');
      if (confirmText === 'リセット') {
        MindLinkStorage.clear();
        location.reload();
      }
    });

    // ── 記憶 ──
    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        MindLinkMemory.renderMemoryList(tab.dataset.filter);
      });
    });
    document.getElementById('btn-add-memory')?.addEventListener('click', () => {
      document.getElementById('new-memory-content').value = '';
      document.getElementById('new-memory-category').value = 'other';
      document.getElementById('new-memory-tags').value = '';
      openModal('add-memory-modal');
    });
    document.getElementById('btn-save-memory')?.addEventListener('click', () => {
      const content = document.getElementById('new-memory-content')?.value.trim();
      const category = document.getElementById('new-memory-category')?.value;
      const tagsRaw = document.getElementById('new-memory-tags')?.value;
      const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(t => t) : [];
      if (!content) { showToast('内容を入力してください'); return; }
      MindLinkMemory.addMemory(content, category, tags, 'user');
      closeModal('add-memory-modal');
      showToast('記憶に追加しました 🧠');
      MindLinkMemory.renderMemoryList('all');
    });

    document.getElementById('btn-update-memory')?.addEventListener('click', () => {
      const id = document.getElementById('edit-memory-id')?.value;
      const content = document.getElementById('edit-memory-content')?.value.trim();
      const category = document.getElementById('edit-memory-category')?.value;
      const tagsRaw = document.getElementById('edit-memory-tags')?.value;
      const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(t => t) : [];
      
      if (!content) { showToast('内容を入力してください'); return; }
      if (!id) return;

      MindLinkStorage.updateMemory(id, { content, category, tags });
      closeModal('edit-memory-modal');
      showToast('記憶を更新しました ✏️');
      
      const activeTab = document.querySelector('.filter-tab.active')?.dataset.filter || 'all';
      MindLinkMemory.renderMemoryList(activeTab);
    });

    // メモリ提案Toast
    document.getElementById('toast-memory-yes')?.addEventListener('click', MindLinkMemory.acceptMemorySuggestion);
    document.getElementById('toast-memory-no')?.addEventListener('click', MindLinkMemory.hideMemorySuggestion);

    // ── ペルソナ ──
    document.getElementById('btn-add-persona')?.addEventListener('click', () => {
      MindLinkPersonas.openEditPersonaModal(null);
    });
    document.getElementById('btn-save-persona')?.addEventListener('click', MindLinkPersonas.savePersona);
    document.getElementById('btn-cancel-persona')?.addEventListener('click', () => closeModal('edit-persona-modal'));

    // ── Google連携 ──
    document.getElementById('btn-google-login')?.addEventListener('click', () => {
      MindLinkGoogleAuth.login();
    });
    document.getElementById('btn-google-logout')?.addEventListener('click', () => {
      MindLinkGoogleAuth.logout();
    });
    document.getElementById('setting-google-client-id')?.addEventListener('input', (e) => {
      MindLinkStorage.updateSettings({ googleClientId: e.target.value.trim() });
    });
    document.getElementById('setting-google-client-secret')?.addEventListener('input', (e) => {
      MindLinkStorage.updateSettings({ googleClientSecret: e.target.value.trim() });
    });
    document.getElementById('setting-search-engine-id')?.addEventListener('input', (e) => {
      MindLinkStorage.updateSettings({ searchEngineId: e.target.value.trim() });
    });

    // ── Spotify連携 ──
    document.getElementById('btn-spotify-login')?.addEventListener('click', () => {
      if (window.MindLinkSpotifyAuth) MindLinkSpotifyAuth.login();
    });
    document.getElementById('btn-spotify-logout')?.addEventListener('click', () => {
      if (window.MindLinkSpotifyAuth) MindLinkSpotifyAuth.logout();
    });
    document.getElementById('setting-spotify-client-id')?.addEventListener('input', (e) => {
      MindLinkStorage.updateSettings({ spotifyClientId: e.target.value.trim() });
    });

    // アバタープリセット
    document.querySelectorAll('.avatar-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const pAvatarText = document.getElementById('persona-avatar');
        const pAvatarPreview = document.getElementById('persona-avatar-preview');
        if (pAvatarText) {
          pAvatarText.style.display = 'block';
          pAvatarText.value = btn.dataset.emoji;
        }
        if (pAvatarPreview) {
          pAvatarPreview.style.display = 'none';
          pAvatarPreview.dataset.base64 = '';
        }
        document.querySelectorAll('.avatar-preset').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    // ペルソナアバター設定（画像）
    document.getElementById('persona-avatar-file')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const base64 = await resizeImageToBase64(file, 200, 200);
        const pAvatarText = document.getElementById('persona-avatar');
        const pAvatarPreview = document.getElementById('persona-avatar-preview');
        if (pAvatarText) pAvatarText.style.display = 'none';
        if (pAvatarPreview) {
          pAvatarPreview.style.display = 'block';
          pAvatarPreview.style.backgroundImage = `url(${base64})`;
          pAvatarPreview.dataset.base64 = base64;
        }
      } catch (err) {
        showToast('画像の読み込みに失敗しました');
      }
      e.target.value = '';
    });
    
    document.getElementById('btn-clear-persona-avatar')?.addEventListener('click', () => {
      const pAvatarText = document.getElementById('persona-avatar');
      const pAvatarPreview = document.getElementById('persona-avatar-preview');
      if (pAvatarText) {
        pAvatarText.style.display = 'block';
        pAvatarText.value = '';
      }
      if (pAvatarPreview) {
        pAvatarPreview.style.display = 'none';
        pAvatarPreview.dataset.base64 = '';
      }
    });

    // ── スレッドコンテキストメニュー ──
    document.getElementById('btn-thread-menu')?.addEventListener('click', (e) => {
      e.stopPropagation();
      showContextMenu(e);
    });
    document.getElementById('context-menu-overlay')?.addEventListener('click', hideContextMenu);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.context-menu')) hideContextMenu();
    });

    document.getElementById('ctx-rename')?.addEventListener('click', () => {
      if (!_contextMenuThreadId) return showToast('メッセージを送信すると操作可能になります');
      const thread = MindLinkStorage.getThread(_contextMenuThreadId);
      if (!thread) return;
      document.getElementById('rename-input').value = thread.title;
      openModal('rename-modal');
    });
    document.getElementById('btn-confirm-rename')?.addEventListener('click', () => {
      const newTitle = document.getElementById('rename-input')?.value.trim();
      if (!newTitle || !_contextMenuThreadId) return;
      MindLinkThreads.updateThreadTitle(_contextMenuThreadId, newTitle);
      document.getElementById('current-thread-title').textContent = newTitle;
      MindLinkThreads.renderThreadList();
      closeModal('rename-modal');
      showToast('名前を変更しました');
    });
    document.getElementById('ctx-pin')?.addEventListener('click', () => {
      if (!_contextMenuThreadId) return showToast('メッセージを送信すると操作可能になります');
      MindLinkThreads.togglePin(_contextMenuThreadId);
      MindLinkThreads.renderThreadList();
      hideContextMenu();
    });
    document.getElementById('ctx-archive')?.addEventListener('click', async () => {
      if (!_contextMenuThreadId) return showToast('メッセージを送信すると操作可能になります');
      hideContextMenu();
      const ok = await MindLinkThreads.archiveThread(_contextMenuThreadId);
      if (!ok) return; // 失敗時は archiveThread 内でトースト表示済み
      MindLinkChat.clearMessages();
      document.getElementById('current-thread-title').textContent = '新しいチャット';
      MindLinkThreads.renderThreadList();
      showToast('アーカイブしました');
    });
    document.getElementById('ctx-export')?.addEventListener('click', () => {
      if (!_contextMenuThreadId) return showToast('メッセージを送信すると操作可能になります');
      MindLinkThreads.exportThread(_contextMenuThreadId);
      hideContextMenu();
    });
    document.getElementById('ctx-delete')?.addEventListener('click', () => {
      if (!_contextMenuThreadId) return showToast('メッセージを送信すると操作可能になります');
      showConfirm('チャットを削除', 'このチャットを完全に削除しますか？', () => {
        MindLinkThreads.deleteThread(_contextMenuThreadId);
        MindLinkChat.clearMessages();
        document.getElementById('current-thread-title').textContent = '新しいチャット';
        MindLinkThreads.renderThreadList();
        hideContextMenu();
        showToast('削除しました');
      });
    });

    // ロック画面
    document.getElementById('btn-unlock')?.addEventListener('click', handleLockUnlock);

    // キーボードショートカット
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllModals();
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('thread-search')?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        document.getElementById('btn-new-thread')?.click();
      }
    });

    // ユーザーアクティビティ監視（自動ロック）
    ['mousemove', 'keydown', 'click', 'touchstart'].forEach(evt => {
      document.addEventListener(evt, () => MindLinkAuth.resetLockTimer(), { passive: true });
    });

    // PWAインストール
    let deferredPrompt;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  起動時データ整合性チェック & 診断バナー（window.__mindlinkDiag）
  //  - 破損の「検知・ログ・診断情報コピー」のみ。自動削除はしない（別PR）。
  //  - PWA単体（開発者コンソール無し）でも調査できるよう、診断JSONを
  //    画面からコピー／表示できる。
  // ─────────────────────────────────────────────────────────────
  const Diagnostics = (() => {
    const PREFIX = 'mindlink_';
    const LIMIT_KB = 5120;        // iOS Safari/PWA の localStorage 上限目安（約5MB）
    const SOFT_LIMIT_KB = 4096;   // 4MB 超で警告
    const HARD_LIMIT_KB = 4608;   // 4.5MB 超で強い警告
    let _lastSend = null;         // 直近の送信サマリー（揮発）
    let _lastSendFailure = null;  // 直近の送信中止（揮発）

    function appVersion() {
      try { return (typeof CACHE_NAME !== 'undefined') ? CACHE_NAME : 'unknown'; }
      catch (_) { return 'unknown'; }
    }
    function isStandalone() {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true;
    }

    function recordSend(info) { _lastSend = info; }
    function recordSendFailure(info) { _lastSendFailure = info; }

    // localStorage を「生で」走査して整合性を検査する。
    // （storage.get() は parse 失敗を握り潰すため、ここでは getItem を直接使う）
    function inspectStorage() {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX)) keys.push(k);
      }

      // 登録済みスレッドID一覧
      let registeredThreadIds = [];
      try {
        const rawThreads = localStorage.getItem(PREFIX + 'threads');
        if (rawThreads) {
          const parsed = JSON.parse(rawThreads);
          if (Array.isArray(parsed)) registeredThreadIds = parsed.map(t => t && t.id).filter(Boolean);
        }
      } catch (_) { /* threads 自体の破損は下のループで parseFailures に入る */ }

      let totalBytes = 0;
      const parseFailures = [];
      const keySizes = [];
      const messageKeys = [];
      const MSG_PREFIX = PREFIX + 'messages_';

      for (const k of keys) {
        const raw = localStorage.getItem(k) || '';
        const bytes = (k.length + raw.length) * 2; // UTF-16 概算
        totalBytes += bytes;
        keySizes.push({ key: k, kb: +(bytes / 1024).toFixed(1) });

        let parseOk = true, error = null, parsed = null;
        try { parsed = JSON.parse(raw); }
        catch (e) { parseOk = false; error = e.message; parseFailures.push(k); }

        if (k.startsWith(MSG_PREFIX)) {
          const threadId = k.slice(MSG_PREFIX.length);
          messageKeys.push({
            threadId,
            count: (parseOk && Array.isArray(parsed)) ? parsed.length : 0,
            parseOk,
            error,
            registered: registeredThreadIds.includes(threadId),
          });
        }
      }

      keySizes.sort((a, b) => b.kb - a.kb);
      const orphanMessageKeys = messageKeys
        .filter(m => !m.registered)
        .map(m => MSG_PREFIX + m.threadId);

      return {
        totalBytes,
        totalKB: +(totalBytes / 1024).toFixed(1),
        topKeys: keySizes.slice(0, 8),
        parseFailures,
        messageKeys,
        registeredThreadIds,
        orphanMessageKeys,
      };
    }

    // 完全な診断オブジェクトを組み立てる
    function build() {
      const s = inspectStorage();
      const currentThreadId = (window.MindLinkThreads && MindLinkThreads.getCurrentThreadId)
        ? MindLinkThreads.getCurrentThreadId()
        : null;
      const currentThreadExists = (currentThreadId == null)
        ? null
        : s.registeredThreadIds.includes(currentThreadId);

      const issues = [];
      if (s.parseFailures.length > 0)
        issues.push('JSON parse 失敗: ' + s.parseFailures.join(', '));
      if (s.orphanMessageKeys.length > 0)
        issues.push('孤児 messages キー: ' + s.orphanMessageKeys.join(', '));
      if (currentThreadId && currentThreadExists === false)
        issues.push('currentThreadId が threads に存在しない: ' + currentThreadId);
      if (s.totalKB > HARD_LIMIT_KB)
        issues.push(`localStorage 逼迫(危険): ${s.totalKB}KB / ${LIMIT_KB}KB`);
      else if (s.totalKB > SOFT_LIMIT_KB)
        issues.push(`localStorage 使用量大: ${s.totalKB}KB / ${LIMIT_KB}KB`);
      if (_lastSendFailure)
        issues.push('直近の送信中止あり: ' + (_lastSendFailure.reason || 'unknown'));

      return {
        timestamp: new Date().toISOString(),
        appVersion: appVersion(),
        userAgent: navigator.userAgent,
        isStandalone: isStandalone(),
        isIOS: /iP(hone|ad|od)/.test(navigator.userAgent),
        storage: {
          totalBytes: s.totalBytes,
          totalKB: s.totalKB,
          limitKB: LIMIT_KB,
          usagePercent: +((s.totalKB / LIMIT_KB) * 100).toFixed(1),
          topKeys: s.topKeys,
        },
        threads: {
          registeredCount: s.registeredThreadIds.length,
          currentThreadId,
          currentThreadExists,
          orphanMessageKeys: s.orphanMessageKeys,
        },
        messages: {
          byThread: s.messageKeys.map(m => ({
            threadId: m.threadId,
            count: m.count,
            parseOk: m.parseOk,
            registered: m.registered,
            error: m.error || undefined,
          })),
        },
        lastSend: _lastSend,
        lastSendFailure: _lastSendFailure,
        issues,
      };
    }

    function asText() { return JSON.stringify(build(), null, 2); }
    function dump() { const d = build(); console.log('[MindLink Diagnostics]', d); return d; }

    // 診断JSONをコピー（3段フォールバック：clipboard API → execCommand → 手動選択）
    async function copyToClipboard() {
      const text = asText();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          showToast('診断情報をコピーしました');
          return true;
        }
      } catch (_) { /* フォールバックへ */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) { showToast('診断情報をコピーしました'); return true; }
      } catch (_) { /* フォールバックへ */ }
      showManualCopy(text);
      return false;
    }

    // コピー不可環境向け：手動で長押し選択できるオーバーレイ表示
    function showManualCopy(text) {
      const id = 'diag-manual-copy';
      const exist = document.getElementById(id);
      if (exist) exist.remove();
      const overlay = document.createElement('div');
      overlay.id = id;
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100001;display:flex;align-items:center;justify-content:center;padding:16px;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;color:#111;max-width:560px;width:100%;max-height:80vh;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:8px;';
      const title = document.createElement('div');
      title.textContent = '診断情報（長押しで全選択してコピーしてください）';
      title.style.cssText = 'font-weight:600;font-size:14px;';
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.readOnly = true;
      ta.style.cssText = 'flex:1;min-height:240px;width:100%;font-size:12px;font-family:monospace;white-space:pre;overflow:auto;box-sizing:border-box;';
      const close = document.createElement('button');
      close.textContent = '閉じる';
      close.style.cssText = 'align-self:flex-end;padding:8px 16px;border:none;border-radius:8px;background:#333;color:#fff;';
      close.onclick = () => overlay.remove();
      box.append(title, ta, close);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      ta.focus();
    }

    // 異常検知時の警告バナー（削除ボタンは持たない）
    function showBanner(issueCount) {
      const id = 'diag-banner';
      if (document.getElementById(id)) return;
      const bar = document.createElement('div');
      bar.id = id;
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:100000;background:#b3261e;color:#fff;font-size:13px;line-height:1.4;padding:8px 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;box-shadow:0 2px 8px rgba(0,0,0,.3);';
      const msg = document.createElement('span');
      msg.style.flex = '1 1 auto';
      msg.textContent = `⚠️ データ整合性に問題を検知しました（動作には影響ありません・${issueCount}件）`;
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = '📋 診断情報をコピー';
      copyBtn.style.cssText = 'padding:6px 10px;border:none;border-radius:6px;background:#fff;color:#b3261e;font-weight:600;font-size:12px;cursor:pointer;';
      copyBtn.onclick = () => copyToClipboard();
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = '✕';
      closeBtn.setAttribute('aria-label', '閉じる');
      closeBtn.style.cssText = 'padding:6px 10px;border:none;border-radius:6px;background:rgba(255,255,255,.2);color:#fff;font-size:12px;cursor:pointer;';
      closeBtn.onclick = () => bar.remove();
      bar.append(msg, copyBtn, closeBtn);
      document.body.appendChild(bar);
    }

    // 起動時整合性チェック（検知・ログ・バナーのみ。削除はしない）
    function runStartupCheck() {
      try {
        const d = build();
        if (d.issues.length > 0) {
          console.warn('[MindLink Diagnostics] 整合性の問題を検知:', d.issues, d);
          showBanner(d.issues.length);
        } else {
          console.log('[MindLink Diagnostics] 整合性チェック OK', {
            storageKB: d.storage.totalKB, threads: d.threads.registeredCount,
          });
        }
      } catch (e) {
        console.error('[MindLink Diagnostics] startup check failed:', e);
      }
    }

    return {
      recordSend, recordSendFailure,
      build, dump, asText,
      copyToClipboard, showBanner, runStartupCheck,
    };
  })();

  window.__mindlinkDiag = Diagnostics;

  return {
    init,
    selectThread,
    openModal,
    closeModal,
    closeAllModals,
    showConfirm,
    showToast,
    showProgress,
    hideProgress,
    exportArchive,
    importArchive,
    openSidebar,
    closeSidebar,
    applyTheme,
    applyColorTheme,
    resizeImageToBase64,
  };
})();

window.MindLinkApp = MindLinkApp;

// ── アプリ起動 ──
document.addEventListener('DOMContentLoaded', () => {
  MindLinkApp.init();
});
