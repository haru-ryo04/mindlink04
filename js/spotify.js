/**
 * MindLink - Spotify Module
 * 現在再生中の取得・30秒ポーリング・変化検知・再生制御・NowPlayingバー管理
 */

const MindLinkSpotify = (() => {

  const API_BASE              = 'https://api.spotify.com/v1';
  const CURRENTLY_PLAYING_URL = `${API_BASE}/me/player/currently-playing`;
  const POLL_INTERVAL_MS      = 30 * 1000; // 30秒

  let _pollingTimer   = null;
  let _lastTrackName  = null;  // 変化検知用
  let _trackForPrompt = null;  // Geminiに渡す用（変化があったときのみ更新）

  // ── 内部ヘルパー: 認証ヘッダー付きリクエスト ──

  async function _request(method, path, body = null) {
    const token = await MindLinkSpotifyAuth.getAccessToken();
    if (!token) return { _error: 'Spotifyに接続されていません。設定からログインしてください。' };

    const options = {
      method,
      headers: { 'Authorization': `Bearer ${token}` }
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(`${API_BASE}${path}`, options);
      // 204 No Content は成功
      if (response.status === 204) return { success: true };
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { _error: err.error?.message || `Spotify Error (${response.status})` };
      }
      // bodyがある場合のみJSON解析
      const text = await response.text();
      return text ? JSON.parse(text) : { success: true };
    } catch (e) {
      return { _error: e.message };
    }
  }

  // ── アクティブデバイス取得 ──

  async function getActiveDevice() {
    const data = await _request('GET', '/me/player/devices');
    if (data._error) return null;
    const devices = data.devices || [];
    return devices.find(d => d.is_active) || devices[0] || null;
  }

  // ── 現在再生中の曲を取得 ──

  async function getCurrentTrack() {
    const token = await MindLinkSpotifyAuth.getAccessToken();
    if (!token) return null;

    try {
      const response = await fetch(CURRENTLY_PLAYING_URL, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.status === 204 || response.status === 202) return null;
      if (!response.ok) return null;

      const data = await response.json();
      if (!data || data.currently_playing_type !== 'track' || !data.item) return null;

      const track = data.item;
      return {
        isPlaying:  data.is_playing,
        trackName:  track.name,
        artistName: track.artists.map(a => a.name).join(', '),
        albumName:  track.album.name,
        trackUri:   track.uri,
        trackUrl:   track.external_urls?.spotify || null,
        progressMs: data.progress_ms,
        durationMs: track.duration_ms,
      };
    } catch (e) {
      console.warn('[MindLink Spotify] getCurrentTrack error:', e);
      return null;
    }
  }

  // ── 曲を検索 ──

  async function searchTrack(query) {
    const token = await MindLinkSpotifyAuth.getAccessToken();
    if (!token) return null;

    try {
      const response = await fetch(
        `${API_BASE}/search?q=${encodeURIComponent(query)}&type=track&limit=1&market=JP`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (!response.ok) return null;
      const data    = await response.json();
      const tracks  = data.tracks?.items;
      if (!tracks || tracks.length === 0) return null;

      return {
        uri:    tracks[0].uri,
        name:   tracks[0].name,
        artist: tracks[0].artists.map(a => a.name).join(', '),
        album:  tracks[0].album.name,
      };
    } catch (e) {
      return null;
    }
  }

  // ── 曲名・アーティスト名で検索して再生 ──

  async function playTrack(query) {
    const track = await searchTrack(query);
    if (!track) return { success: false, message: `「${query}」は見つかりませんでした。別のキーワードを試してください。` };

    const device   = await getActiveDevice();
    const deviceQs = device ? `?device_id=${device.id}` : '';

    const result = await _request('PUT', `/me/player/play${deviceQs}`, { uris: [track.uri] });
    if (result._error) {
      // デバイス未アクティブの場合の案内
      if (result._error.includes('403') || result._error.includes('Premium')) {
        return { success: false, message: 'Spotify Premiumが必要です。' };
      }
      return { success: false, message: `再生できませんでした: ${result._error}` };
    }

    // ポーリングキャッシュ即時更新
    _lastTrackName  = track.name;
    _trackForPrompt = { isPlaying: true, trackName: track.name, artistName: track.artist, albumName: track.album };
    renderNowPlayingBar(_trackForPrompt);

    return { success: true, message: `「${track.name}」（${track.artist}）を再生します🎵` };
  }

  // ── 一時停止 ──

  async function pausePlayback() {
    const result = await _request('PUT', '/me/player/pause');
    if (result._error) return { success: false, message: result._error };
    if (_trackForPrompt) _trackForPrompt.isPlaying = false;
    return { success: true, message: '一時停止しました⏸' };
  }

  // ── 再生再開 ──

  async function resumePlayback() {
    const device   = await getActiveDevice();
    const deviceQs = device ? `?device_id=${device.id}` : '';
    const result   = await _request('PUT', `/me/player/play${deviceQs}`);
    if (result._error) return { success: false, message: result._error };
    if (_trackForPrompt) _trackForPrompt.isPlaying = true;
    return { success: true, message: '再生を再開しました▶️' };
  }

  // ── 次の曲 ──

  async function skipToNext() {
    const result = await _request('POST', '/me/player/next');
    if (result._error) return { success: false, message: result._error };
    // 少し待ってから現在曲を更新
    setTimeout(() => _poll(), 1500);
    return { success: true, message: '次の曲にスキップしました⏭' };
  }

  // ── 前の曲 ──

  async function skipToPrevious() {
    const result = await _request('POST', '/me/player/previous');
    if (result._error) return { success: false, message: result._error };
    setTimeout(() => _poll(), 1500);
    return { success: true, message: '前の曲に戻りました⏮' };
  }

  // ── 音量設定 ──

  async function setVolume(percent) {
    const vol    = Math.max(0, Math.min(100, Math.round(Number(percent))));
    const result = await _request('PUT', `/me/player/volume?volume_percent=${vol}`);
    if (result._error) return { success: false, message: result._error };
    return { success: true, message: `音量を${vol}%にしました🔊` };
  }

  // ── ポーリング開始 ──

  function startPolling() {
    if (_pollingTimer) return;
    console.log('[MindLink Spotify] Polling started (30s).');
    _poll();
    _pollingTimer = setInterval(_poll, POLL_INTERVAL_MS);
  }

  // ── ポーリング停止 ──

  function stopPolling() {
    if (_pollingTimer) {
      clearInterval(_pollingTimer);
      _pollingTimer = null;
      console.log('[MindLink Spotify] Polling stopped.');
    }
  }

  // ── 内部ポーリング処理 ──

  async function _poll() {
    const track = await getCurrentTrack();

    if (!track || !track.isPlaying) {
      _lastTrackName  = null;
      _trackForPrompt = null;
      renderNowPlayingBar(null);
      return;
    }

    if (track.trackName !== _lastTrackName) {
      console.log(`[MindLink Spotify] Track changed: "${track.trackName}" by ${track.artistName}`);
      _lastTrackName  = track.trackName;
      _trackForPrompt = track;
    }

    renderNowPlayingBar(track);
  }

  // ── Geminiプロンプト用: キャッシュされた曲情報を返す（API不使用） ──

  function getTrackForPrompt() {
    return _trackForPrompt;
  }

  // ── NowPlayingバーのUI更新 ──

  function renderNowPlayingBar(track) {
    const bar    = document.getElementById('now-playing-bar');
    const textEl = document.getElementById('now-playing-text');
    if (!bar || !textEl) return;

    if (!track || !track.isPlaying) {
      bar.style.display = 'none';
      return;
    }

    textEl.textContent = `${track.trackName}  —  ${track.artistName}`;
    bar.style.display  = 'flex';
  }

  return {
    getCurrentTrack,
    searchTrack,
    playTrack,
    pausePlayback,
    resumePlayback,
    skipToNext,
    skipToPrevious,
    setVolume,
    startPolling,
    stopPolling,
    getTrackForPrompt,
    renderNowPlayingBar,
  };

})();

window.MindLinkSpotify = MindLinkSpotify;
