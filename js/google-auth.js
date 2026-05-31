/**
 * MindLink - Google OAuth 2.0 Module (Persistent with Refresh Token)
 */

const MindLinkGoogleAuth = (() => {
  let _codeClient = null;
  let _accessToken = null;
  let _expiresAt = 0;
  let _isRefreshing = false;

  const SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/userinfo.profile',
    'openid'
  ].join(' ');

  function login() {
    const settings = MindLinkStorage.getSettings();
    const clientId = settings.googleClientId;
    
    if (!clientId || !settings.googleClientSecret) {
      MindLinkApp.showToast('クライアントIDとシークレットを先に設定してください');
      return;
    }
    
    // ステート代わりのnonce（簡易的）
    const state = Math.random().toString(36).substring(7);
    localStorage.setItem('mindlink_google_oauth_state', state);

    const redirectUri = MindLinkConfig.REDIRECT_URI;
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);

    console.log('[MindLink Auth] Redirecting to Google:', authUrl.toString());
    window.location.href = authUrl.toString();
  }

  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const savedState = localStorage.getItem('mindlink_google_oauth_state');

    if (!code) return;

    // ステート検証（セキュリティ）
    if (state !== savedState) {
      console.warn('[MindLink Auth] State mismatch. Possible CSRF.');
      return;
    }
    localStorage.removeItem('mindlink_google_oauth_state');

    // クリーンアップ（URLからcodeを消す）
    const newUrl = MindLinkConfig.REDIRECT_URI;
    window.history.replaceState({}, document.title, newUrl);

    try {
      const settings = MindLinkStorage.getSettings();
      await exchangeCodeForTokens(code, settings.googleClientId, settings.googleClientSecret);
      await checkInitialStatus();
      MindLinkApp.showToast('Google連携が完了しました！ ✨');
    } catch (e) {
      console.error('[MindLink Auth] ログインコールバックエラー:', e);
      updateStatus('交換失敗');
      MindLinkApp.showToast('Google連携に失敗しました。');
    }
  }

  async function exchangeCodeForTokens(code, clientId, clientSecret) {
    updateStatus('トークン取得中...');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: MindLinkConfig.REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[MindLink Auth] Token Exchange Error Response:', err);
      throw new Error(err.error_description || err.error || 'Token exchange failed');
    }

    const data = await response.json();
    saveToken(data);
    if (data.refresh_token) {
      await MindLinkStorage.idbSetToken('google_refresh_token', data.refresh_token);
    }
    return data;
  }

  async function refreshAccessToken() {
    if (_isRefreshing) return null;
    _isRefreshing = true;
    try {
      const settings = MindLinkStorage.getSettings();
      const refreshToken = await MindLinkStorage.idbGetToken('google_refresh_token');
      
      if (!refreshToken || !settings.googleClientId || !settings.googleClientSecret) {
        _isRefreshing = false;
        return null;
      }

      console.log('[MindLink Auth] Refreshing access token...');
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: settings.googleClientId,
          client_secret: settings.googleClientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        })
      });

      if (!response.ok) {
        const err = await response.json();
        console.error('Token refresh failed:', err);
        if (err.error === 'invalid_grant') {
           console.warn('[MindLink Auth] Refresh token invalid, logging out.');
           logout();
        }
        _isRefreshing = false;
        return null;
      }

      const data = await response.json();
      saveToken(data);
      console.log('[MindLink Auth] Token refreshed successfully.');
      _isRefreshing = false;
      return data.access_token;
    } catch (e) {
      console.error('Token refresh error:', e);
      _isRefreshing = false;
      return null;
    }
  }


  function logout() {
    const saved = MindLinkStorage.get('google_token');
    if (saved && saved.access_token) {
      // Revoke in background
      fetch(`https://oauth2.googleapis.com/revoke?token=${saved.access_token}`, { method: 'POST' }).catch(() => {});
    }
    MindLinkStorage.set('google_token', null);
    MindLinkStorage.idbDeleteToken('google_refresh_token');
    _accessToken = null;
    _expiresAt = 0;
    updateStatus('未連携');
    document.getElementById('btn-google-login').style.display = 'inline-block';
    document.getElementById('btn-google-logout').style.display = 'none';
    MindLinkApp.showToast('Google連携を解除しました');
  }

  async function getAccessToken() {
    const saved = MindLinkStorage.get('google_token');
    if (!saved || !saved.access_token) {
        // アクセストークンはないがリフレッシュトークンがあるか確認
        const refreshToken = await MindLinkStorage.idbGetToken('google_refresh_token');
        if (refreshToken) {
            return await refreshAccessToken();
        }
        return null;
    }
    
    // 期限切れ5分前ならリフレッシュ
    if (Date.now() + 300000 >= saved.expires_at) {
      return await refreshAccessToken();
    }
    
    return saved.access_token;
  }

  function getAccessTokenSync() {
    const saved = MindLinkStorage.get('google_token');
    if (!saved || Date.now() >= saved.expires_at) return null;
    return saved.access_token;
  }

  function saveToken(response) {
    const expiresAt = Date.now() + (response.expires_in * 1000);
    const tokenData = {
      access_token: response.access_token,
      expires_at: expiresAt,
      scope: response.scope
    };
    MindLinkStorage.set('google_token', tokenData);
  }

  function updateStatus(text) {
    const el = document.getElementById('google-auth-status');
    if (el) el.textContent = text;
  }

  async function checkInitialStatus() {
    // URLに認可コードが含まれているかチェック（コールバック処理）
    if (window.location.search.includes('code=')) {
      await handleCallback();
    }

    const saved = MindLinkStorage.get('google_token');
    const refreshToken = await MindLinkStorage.idbGetToken('google_refresh_token');
    const loginBtn = document.getElementById('btn-google-login');
    const logoutBtn = document.getElementById('btn-google-logout');

    if (refreshToken || (saved && saved.access_token && Date.now() < saved.expires_at)) {
      updateStatus('連携中 ✓');
      if (loginBtn) loginBtn.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'inline-block';
    } else {
      updateStatus('未連携');
      if (loginBtn) loginBtn.style.display = 'inline-block';
      if (logoutBtn) logoutBtn.style.display = 'none';
    }
  }

  return { login, logout, getAccessToken, getAccessTokenSync, checkInitialStatus, handleCallback };
})();

window.MindLinkGoogleAuth = MindLinkGoogleAuth;
