/**
 * MindLink - Spotify Auth Module
 * PKCE (Authorization Code with PKCE) フローによる認証
 * Client Secret 不使用 / refresh_token ローテーション対応
 */

const MindLinkSpotifyAuth = (() => {

  const SPOTIFY_AUTH_URL  = 'https://accounts.spotify.com/authorize';
  const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
  const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';

  const TOKEN_KEY         = 'mindlink_spotify_token';
  const STATE_KEY         = 'mindlink_spotify_oauth_state';
  const VERIFIER_KEY      = 'mindlink_spotify_code_verifier';
  const REFRESH_TOKEN_KEY = 'spotify_refresh_token';

  // ── PKCE ヘルパー ──

  function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array).map(b => chars[b % chars.length]).join('');
  }

  async function sha256(plain) {
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);
    return crypto.subtle.digest('SHA-256', data);
  }

  function base64UrlEncode(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = '';
    bytes.forEach(b => { str += String.fromCharCode(b); });
    return btoa(str)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  async function generatePKCE() {
    const verifier  = generateRandomString(128);
    const hash      = await sha256(verifier);
    const challenge = base64UrlEncode(hash);
    return { verifier, challenge };
  }

  // ── ログイン ──

  async function login() {
    const settings = MindLinkStorage.getSettings();
    const clientId = settings.spotifyClientId;

    if (!clientId) {
      if (window.MindLinkApp) MindLinkApp.showToast('Spotify Client ID を先に設定してください');
      return;
    }

    const { verifier, challenge } = await generatePKCE();

    // verifier を sessionStorage に保存（コールバック時に使用）
    sessionStorage.setItem(VERIFIER_KEY, verifier);

    // state: spotify_ プレフィックス付きでコールバック振り分けに使用
    const state = 'spotify_' + generateRandomString(16);
    localStorage.setItem(STATE_KEY, state);

    const redirectUri = MindLinkConfig.REDIRECT_URI;
    const params = new URLSearchParams({
      client_id:             clientId,
      response_type:         'code',
      redirect_uri:          redirectUri,
      code_challenge_method: 'S256',
      code_challenge:        challenge,
      state:                 state,
      scope:                 SCOPES,
    });

    console.log('[MindLink Spotify] Redirecting to Spotify auth...');
    window.location.href = `${SPOTIFY_AUTH_URL}?${params.toString()}`;
  }

  // ── コールバック処理 ──

  async function handleCallback(code, state) {
    const savedState = localStorage.getItem(STATE_KEY);
    if (!state || state !== savedState) {
      console.warn('[MindLink Spotify] State mismatch. Possible CSRF.');
      return;
    }
    localStorage.removeItem(STATE_KEY);

    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    if (!verifier) {
      console.error('[MindLink Spotify] Code verifier not found in sessionStorage.');
      return;
    }
    sessionStorage.removeItem(VERIFIER_KEY);

    const settings  = MindLinkStorage.getSettings();
    const clientId  = settings.spotifyClientId;

    try {
      updateStatus('トークン取得中...');
      const body = new URLSearchParams({
        grant_type:    'authorization_code',
        code:          code,
        redirect_uri:  MindLinkConfig.REDIRECT_URI,
        client_id:     clientId,
        code_verifier: verifier,
      });

      const response = await fetch(SPOTIFY_TOKEN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body.toString(),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error_description || err.error || 'Token exchange failed');
      }

      const data = await response.json();
      _saveToken(data);
      if (data.refresh_token) {
        await MindLinkStorage.idbSetToken(REFRESH_TOKEN_KEY, data.refresh_token);
        console.log('[MindLink Spotify] Refresh token saved to IndexedDB.');
      }

      updateStatus('連携中 ✓');
      _updateUI(true);
      if (window.MindLinkApp)   MindLinkApp.showToast('Spotify連携が完了しました 🎵');
      if (window.MindLinkSpotify) MindLinkSpotify.startPolling();

    } catch (e) {
      console.error('[MindLink Spotify] handleCallback error:', e);
      updateStatus('連携失敗');
      if (window.MindLinkApp) MindLinkApp.showToast('Spotify連携に失敗しました: ' + e.message);
    }
  }

  // ── トークンリフレッシュ ──

  let _isRefreshing = false;

  async function refreshAccessToken() {
    if (_isRefreshing) return null;
    _isRefreshing = true;

    try {
      const refreshToken = await MindLinkStorage.idbGetToken(REFRESH_TOKEN_KEY);
      if (!refreshToken) {
        console.warn('[MindLink Spotify] No refresh token found.');
        _isRefreshing = false;
        return null;
      }

      const settings = MindLinkStorage.getSettings();
      const clientId = settings.spotifyClientId;
      if (!clientId) {
        _isRefreshing = false;
        return null;
      }

      console.log('[MindLink Spotify] Refreshing access token...');

      const body = new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     clientId,
      });

      const response = await fetch(SPOTIFY_TOKEN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body.toString(),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.error('[MindLink Spotify] Refresh failed:', err);
        if (err.error === 'invalid_grant') {
          console.warn('[MindLink Spotify] Refresh token invalid, logging out.');
          logout();
        }
        _isRefreshing = false;
        return null;
      }

      const data = await response.json();
      _saveToken(data);

      // ローテーション対応: 新しい refresh_token が返ってきた場合はIndexedDBを上書き
      if (data.refresh_token) {
        await MindLinkStorage.idbSetToken(REFRESH_TOKEN_KEY, data.refresh_token);
        console.log('[MindLink Spotify] Refresh token rotated and saved.');
      }

      console.log('[MindLink Spotify] Access token refreshed successfully.');
      _isRefreshing = false;
      return data.access_token;

    } catch (e) {
      console.error('[MindLink Spotify] refreshAccessToken error:', e);
      _isRefreshing = false;
      return null;
    }
  }

  // ── アクセストークン取得（自動リフレッシュ付き） ──

  async function getAccessToken() {
    const saved = _loadToken();
    if (!saved || !saved.access_token) {
      // アクセストークンはないがリフレッシュトークンがある可能性
      const refreshToken = await MindLinkStorage.idbGetToken(REFRESH_TOKEN_KEY);
      if (refreshToken) return await refreshAccessToken();
      return null;
    }

    // 期限切れ5分前ならリフレッシュ
    if (Date.now() + 5 * 60 * 1000 >= saved.expires_at) {
      return await refreshAccessToken();
    }

    return saved.access_token;
  }

  // ── ログアウト ──

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    MindLinkStorage.idbDeleteToken(REFRESH_TOKEN_KEY);
    updateStatus('未連携');
    _updateUI(false);
    if (window.MindLinkSpotify) {
      MindLinkSpotify.stopPolling();
      MindLinkSpotify.renderNowPlayingBar(null);
    }
    if (window.MindLinkApp) MindLinkApp.showToast('Spotify連携を解除しました');
    console.log('[MindLink Spotify] Logged out.');
  }

  // ── 起動時ステータス確認 ──

  async function checkInitialStatus() {
    const saved       = _loadToken();
    const refreshToken = await MindLinkStorage.idbGetToken(REFRESH_TOKEN_KEY);
    const isLinked    = refreshToken || (saved && saved.access_token && Date.now() < saved.expires_at);

    // Redirect URI を表示
    const uriEl = document.getElementById('spotify-redirect-uri');
    if (uriEl) uriEl.textContent = MindLinkConfig.REDIRECT_URI;

    if (isLinked) {
      updateStatus('連携中 ✓');
      _updateUI(true);
      // ポーリング開始
      if (window.MindLinkSpotify) MindLinkSpotify.startPolling();
    } else {
      updateStatus('未連携');
      _updateUI(false);
    }
  }

  // ── 内部ヘルパー ──

  function _saveToken(data) {
    const expiresAt = Date.now() + (data.expires_in * 1000);
    localStorage.setItem(TOKEN_KEY, JSON.stringify({
      access_token: data.access_token,
      expires_at:   expiresAt,
    }));
  }

  function _loadToken() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function updateStatus(text) {
    const el = document.getElementById('spotify-auth-status');
    if (el) el.textContent = text;
  }

  function _updateUI(isLinked) {
    const loginBtn  = document.getElementById('btn-spotify-login');
    const logoutBtn = document.getElementById('btn-spotify-logout');
    if (loginBtn)  loginBtn.style.display  = isLinked ? 'none' : 'inline-block';
    if (logoutBtn) logoutBtn.style.display = isLinked ? 'inline-block' : 'none';
  }

  return {
    login,
    handleCallback,
    refreshAccessToken,
    getAccessToken,
    logout,
    checkInitialStatus,
  };

})();

window.MindLinkSpotifyAuth = MindLinkSpotifyAuth;
