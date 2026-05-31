/**
 * MindLink - Google Services Module
 * 各種Google APIの呼び出しと、Gemini向けの関数定義（Function Declaration）
 */

const MindLinkGoogleServices = (() => {

  // --- HELPERS ---

  let mapsLoadedPromise = null;

  /**
   * Google Maps SDK の動的ロード（loading=async対応、新API導入）
   */
  async function ensureMapsSDK() {
    if (mapsLoadedPromise) return mapsLoadedPromise;

    mapsLoadedPromise = (async () => {
      const apiKey = await MindLinkAuth.getApiKey('google_services');
      if (!apiKey) throw new Error('Googleツール用APIキーが設定されていません。設定画面で登録してください。');

      // すでにロード済みなら何もしない
      if (window.google && window.google.maps) return;

      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        // loading=async を付けて非同期ロード。librariesはimportLibrary()で動的取得するためURLに不要
        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&loading=async`;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => {
          mapsLoadedPromise = null;
          reject(new Error('Google Maps SDK の読み込みに失敗しました。APIキーまたはネットワークを確認してください。'));
        };
        document.head.appendChild(script);
      });
    })();

    return mapsLoadedPromise;
  }

  // --- API CALLS ---

  /**
   * Google Calendar: 予定リストを取得
   */
  async function listCalendarEvents() {
    const token = await MindLinkGoogleAuth.getAccessToken();
    if (!token) throw new Error('Google連携がされていません。設定からログインしてください。');

    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10&orderBy=startTime&singleEvents=true', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) {
        const err = await response.json();
        throw new Error('Google Calendar API Error: ' + (err.error?.message || response.statusText));
    }
    
    const data = await response.json();
    return data.items.map(e => ({
      summary: e.summary,
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      description: e.description || '',
      location: e.location || ''
    }));
  }

  /**
   * Google Calendar: 予定を追加
   */
  async function createCalendarEvent(summary, startTime, endTime, description = '', location = '') {
    const token = await MindLinkGoogleAuth.getAccessToken();
    if (!token) throw new Error('Google連携がされていません。');

    const event = {
      summary,
      start: { dateTime: startTime },
      end: { dateTime: endTime || startTime }, // 終了時間がなければ開始時間と同じに
      description,
      location
    };

    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    });

    const data = await response.json();
    return { success: response.ok, event: data };
  }

  /**
   * Google Tasks: タスクリストを取得
   */
  async function listTasks() {
    const token = await MindLinkGoogleAuth.getAccessToken();
    if (!token) throw new Error('Google連携がされていません。');

    const response = await fetch('https://www.googleapis.com/tasks/v1/lists/@default/tasks', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    return data.items?.map(t => ({ title: t.title, status: t.status, notes: t.notes || '' })) || [];
  }

  /**
   * Google Tasks: タスクを追加
   */
  async function createTask(title, notes = '') {
    const token = await MindLinkGoogleAuth.getAccessToken();
    if (!token) throw new Error('Google連携がされていません。');

    const response = await fetch('https://www.googleapis.com/tasks/v1/lists/@default/tasks', {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title, notes })
    });
    const data = await response.json();
    return { success: response.ok, task: data };
  }

  /**
   * YouTube: 動画検索
   */
  async function searchYouTube(query) {
    const token = await MindLinkGoogleAuth.getAccessToken();
    if (!token) throw new Error('Google連携がされていません。');

    const response = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=5&q=${encodeURIComponent(query)}&type=video`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    return data.items?.map(v => ({
      title: v.snippet.title,
      videoId: v.id.videoId,
      channel: v.snippet.channelTitle,
      url: `https://www.youtube.com/watch?v=${v.id.videoId}`
    })) || [];
  }

  /**
   * 現在地を取得
   */
  function getCurrentLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve({ error: "このブラウザは位置情報の取得に対応していません。" });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => {
          let msg = "位置情報の取得に失敗しました。";
          if (err.code === err.PERMISSION_DENIED) msg = "位置情報の利用が許可されていません。ブラウザの設定から許可してください。";
          else if (err.code === err.TIMEOUT) msg = "位置情報の取得がタイムアウトしました。";
          resolve({ error: msg });
        },
        { timeout: 10000, enableHighAccuracy: true }
      );
    });
  }

  /**
   * Google Places: 周辺スポット検索（新API: Place.searchByText）
   */
  async function searchNearbyPlaces(lat, lng, keyword, radius = 1000) {
    await ensureMapsSDK();
    const { Place } = await google.maps.importLibrary('places');

    const { places } = await Place.searchByText({
      textQuery: keyword,
      fields: ['id', 'displayName', 'rating', 'userRatingCount', 'formattedAddress', 'types', 'location'],
      locationBias: { center: { lat, lng }, radius },
      maxResultCount: 10
    });

    return (places || []).map(p => ({
      name: p.displayName,
      place_id: p.id,
      rating: p.rating,
      user_ratings_total: p.userRatingCount,
      address: p.formattedAddress,
      types: p.types
    }));
  }

  /**
   * Google Places: スポット詳細取得（新API: new Place() + fetchFields）
   */
  async function getPlaceDetails(place_id) {
    await ensureMapsSDK();
    const { Place } = await google.maps.importLibrary('places');

    const place = new Place({ id: place_id });
    await place.fetchFields({
      fields: ['displayName', 'rating', 'formattedAddress', 'regularOpeningHours', 'reviews', 'googleMapsUri', 'userRatingCount', 'priceLevel']
    });

    return {
      name: place.displayName,
      rating: place.rating,
      user_ratings_total: place.userRatingCount,
      address: place.formattedAddress,
      opening_hours: place.regularOpeningHours?.weekdayDescriptions
        || (place.regularOpeningHours ? '営業情報あり' : '営業時間不明'),
      price_level: place.priceLevel,
      url: place.googleMapsUri,
      top_reviews: (place.reviews || []).slice(0, 3).map(r => ({
        rating: r.rating,
        text: (r.text?.text || r.text || '').toString().slice(0, 100) + '...'
      }))
    };
  }

  // --- GEMINI TOOL DECLARATIONS ---

  const TOOL_DECLARATIONS = [
    {
      name: "list_calendar_events",
      description: "Googleカレンダーから今後の予定（最大10件）を取得します。",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "create_calendar_event",
      description: "Googleカレンダーに新しい予定を登録します。",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "予定のタイトル" },
          startTime: { type: "string", description: "開始時間（ISO 8601形式。例: 2024-04-10T15:00:00Z）" },
          endTime: { type: "string", description: "終了時間（ISO 8601形式。例: 2024-04-10T16:00:00Z）" },
          description: { type: "string", description: "予定の詳細説明（任意）" },
          location: { type: "string", description: "場所（任意）" }
        },
        required: ["summary", "startTime"]
      }
    },
    {
      name: "add_app_calendar_event",
      description: "アプリ内カレンダーに新しい予定を追加します。Googleカレンダー連携の有無に関わらず使えます。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "予定のタイトル" },
          emoji: { type: "string", description: "予定を表わす絵文字（例: 🏃 🍽️ 🎉 💼 ✈️）（未指定の場合は📅）" },
          start_date: { type: "string", description: "開始日（YYYY-MM-DD形式）" },
          end_date: { type: "string", description: "連日予定の終了日（YYYY-MM-DD。単日の場合は空）" },
          start_time: { type: "string", description: "開始時刻（HH:MM形式。終日予定の場合は空）" },
          end_time: { type: "string", description: "終了時刻（HH:MM形式。任意）" },
          is_all_day: { type: "boolean", description: "終日予定の場合はtrue" },
          description: { type: "string", description: "予定の詳細（任意）" }
        },
        required: ["title", "start_date"]
      }
    },
    {
      name: "list_app_calendar_events",
      description: "アプリ内カレンダーの予定の一覧を取得します。日付を指定するとその日の予定のみ取得できます。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "特定の日付（YYYY-MM-DD）。空の場合は全予定を取得" }
        }
      }
    },
    {
      name: "update_calendar_event",
      description: "アプリ内カレンダーの既存の予定を更新します。",
      parameters: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "更新する予定のID（list_app_calendar_eventsで取得）" },
          title: { type: "string", description: "予定のタイトル（任意）" },
          emoji: { type: "string", description: "絵文字（任意）" },
          start_date: { type: "string", description: "開始日（YYYY-MM-DD）（任意）" },
          end_date: { type: "string", description: "終了日（YYYY-MM-DD）（任意）" },
          start_time: { type: "string", description: "開始時刻（HH:MM）（任意）" },
          end_time: { type: "string", description: "終了時刻（HH:MM）（任意）" },
          description: { type: "string", description: "詳細メモ（任意）" }
        },
        required: ["event_id"]
      }
    },
    {
      name: "delete_app_calendar_event",
      description: "アプリ内カレンダーから指定した予定を削除します。",
      parameters: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "削除する予定のID" }
        },
        required: ["event_id"]
      }
    },
    {
      name: "list_tasks",
      description: "Google Tasks (ToDoリスト) からタスクの一覧を取得します。",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "create_task",
      description: "Google Tasks (ToDoリスト) に新しいタスクを追加します。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "タスクのタイトル" },
          notes: { type: "string", description: "タスクの詳細メモ（任意）" }
        },
        required: ["title"]
      }
    },
    {
      name: "search_youtube",
      description: "YouTubeでキーワードを使って動画を検索し、リンクを取得します。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "検索キーワード" }
        },
        required: ["query"]
      }
    },
    {
      name: "get_current_location",
      description: "ユーザーの現在地（緯度・経度）を取得します。付近の情報を探す際に使います。",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "search_nearby_places",
      description: "指定した場所の周辺にあるカフェ、ホテル、レストランなどのスポットを検索します。",
      parameters: {
        type: "object",
        properties: {
          lat: { type: "number", description: "緯度" },
          lng: { type: "number", description: "経度" },
          keyword: { type: "string", description: "検索キーワード（カフェ、ホテル、レストランなど）" },
          radius: { type: "number", description: "検索半径（メートル。デフォルト1000m）" }
        },
        required: ["lat", "lng", "keyword"]
      }
    },
    {
      name: "get_place_details",
      description: "特定のスポットの詳細情報（住所、評価、営業時間、口コミなど）を取得します。",
      parameters: {
        type: "object",
        properties: {
          place_id: { type: "string", description: "スポットの一意なID（search_nearby_placesから取得します）" }
        },
        required: ["place_id"]
      }
    },
    {
      name: "list_memories",
      description: "これまでに保存したユーザーのプロフィール、好み、過去の出来事などの「記憶」の一覧を取得します。",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "add_memory",
      description: "ユーザーに関する新しい情報を「記憶」として保存します。将来の会話で参照できるようになります。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "保存する内容。簡潔かつ明確な一文にしてください。" },
          category: { 
            type: "string", 
            enum: ["profile", "preference", "knowledge", "other"],
            description: "記憶のカテゴリ（プロフィール、好み、知識、その他）" 
          },
          tags: { 
            type: "array", 
            items: { type: "string" },
            description: "関連するキーワードのリスト（任意）" 
          }
        },
        required: ["content", "category"]
      }
    },
    // ── Spotify 再生制御 ──
    {
      name: "spotify_play_track",
      description: "Spotifyで指定した曲を検索して再生します。「この曲かけて」「このアーティストの曲流して」などに使用します。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "曲名やアーティスト名（両方含めると精度が上がる）" }
        },
        required: ["query"]
      }
    },
    {
      name: "spotify_pause",
      description: "Spotifyの再生を一時停止します。「一時停止して」「ミュート」などに使用。",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "spotify_resume",
      description: "Spotifyの一時停止した再生を再開します。「再生して」「続きかけて」などに使用。",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "spotify_next_track",
      description: "Spotifyで次の曲にスキップします。「次の曲にして」「スキップ」などに使用。",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "spotify_previous_track",
      description: "Spotifyで前の曲に戻ります。「前の曲に戻して」などに使用。",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "spotify_set_volume",
      description: "Spotifyの音量を調整します（0〜100）。「音量上げて」「音量50にして」などに使用。",
      parameters: {
        type: "object",
        properties: {
          percent: { type: "number", description: "音量（0〜100）" }
        },
        required: ["percent"]
      }
    },
    {
      name: "spotify_get_current_track",
      description: "Spotifyの現在再生中の曲情報を取得します。「今何聴いてる？」などに自律的に使用。",
      parameters: { type: "object", properties: {} }
    },
  ];

  /**
   * 関数名に応じた実行
   */
  async function callFunction(name, args) {
    console.log(`[GoogleServices] Calling: ${name}`, args);
    switch (name) {
      case "list_calendar_events": return await listCalendarEvents();
      case "create_calendar_event": return await createCalendarEvent(args.summary, args.startTime, args.endTime, args.description, args.location);
      case "add_app_calendar_event": {
        if (!window.MindLinkCalendar) return { error: 'Calendar module not loaded' };
        const ev = MindLinkCalendar.aiAddEvent({
          emoji: args.emoji || '📅',
          title: args.title,
          startDate: args.start_date,
          endDate: args.end_date || '',
          startTime: args.start_time || '',
          endTime: args.end_time || '',
          isAllDay: args.is_all_day || false,
          description: args.description || '',
        });
        const timeStr = ev.isAllDay ? '（終日）' : (ev.startTime ? ` ${ev.startTime}` : '');
        return `アプリ内カレンダーに予定を追加しました。タイトル: ${ev.emoji} ${ev.title}、日付: ${ev.startDate}${ev.endDate ? ' 〜 ' + ev.endDate : ''}${timeStr}。`;
      }
      case "list_app_calendar_events": {
        if (!window.MindLinkCalendar) return { error: 'Calendar module not loaded' };
        return MindLinkCalendar.aiListEvents(args.date || null);
      }
      case "update_calendar_event": {
        if (!window.MindLinkCalendar) return { error: 'Calendar module not loaded' };
        const partial = {};
        if (args.title !== undefined) partial.title = args.title;
        if (args.emoji !== undefined) partial.emoji = args.emoji;
        if (args.start_date !== undefined) partial.startDate = args.start_date;
        if (args.end_date !== undefined) partial.endDate = args.end_date;
        if (args.start_time !== undefined) partial.startTime = args.start_time;
        if (args.end_time !== undefined) partial.endTime = args.end_time;
        if (args.description !== undefined) partial.description = args.description;
        const ok = MindLinkCalendar.aiUpdateEvent(args.event_id, partial);
        return ok ? '予定を更新しました。' : '指定されたIDの予定が見つかりませんでした。';
      }
      case "delete_app_calendar_event": {
        if (!window.MindLinkCalendar) return { error: 'Calendar module not loaded' };
        const ok = MindLinkCalendar.aiDeleteEvent(args.event_id);
        return ok ? '予定を削除しました。' : '指定されたIDの予定が見つかりませんでした。';
      }
      case "list_tasks": return await listTasks();
      case "create_task": return await createTask(args.title, args.notes);
      case "search_youtube": return await searchYouTube(args.query);
      case "get_current_location": return await getCurrentLocation();
      case "search_nearby_places": return await searchNearbyPlaces(args.lat, args.lng, args.keyword, args.radius);
      case "get_place_details": return await getPlaceDetails(args.place_id);
      case "list_memories": 
        return MindLinkStorage.getMemories();
      case "add_memory": 
        return MindLinkMemory.addMemory(args.content, args.category, args.tags || [], 'ai');
      // ── Spotify 再生制御 ──
      case "spotify_play_track":
        if (!window.MindLinkSpotify) return { error: 'Spotifyモジュールが読み込まれていません' };
        return await MindLinkSpotify.playTrack(args.query);
      case "spotify_pause":
        if (!window.MindLinkSpotify) return { error: 'Spotifyモジュールが読み込まれていません' };
        return await MindLinkSpotify.pausePlayback();
      case "spotify_resume":
        if (!window.MindLinkSpotify) return { error: 'Spotifyモジュールが読み込まれていません' };
        return await MindLinkSpotify.resumePlayback();
      case "spotify_next_track":
        if (!window.MindLinkSpotify) return { error: 'Spotifyモジュールが読み込まれていません' };
        return await MindLinkSpotify.skipToNext();
      case "spotify_previous_track":
        if (!window.MindLinkSpotify) return { error: 'Spotifyモジュールが読み込まれていません' };
        return await MindLinkSpotify.skipToPrevious();
      case "spotify_set_volume":
        if (!window.MindLinkSpotify) return { error: 'Spotifyモジュールが読み込まれていません' };
        return await MindLinkSpotify.setVolume(args.percent);
      case "spotify_get_current_track":
        if (!window.MindLinkSpotify) return { error: 'Spotifyモジュールが読み込まれていません' };
        return await MindLinkSpotify.getCurrentTrack() || { message: '現在再生中の曲はありません' };
      default: throw new Error(`Unknown function: ${name}`);
    }
  }

  return {
    TOOL_DECLARATIONS,
    callFunction
  };
})();

window.MindLinkGoogleServices = MindLinkGoogleServices;
