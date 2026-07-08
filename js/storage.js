/**
 * MindLink - Storage Module
 * localStorageを操作する低レベルのデータ層
 */

const MindLinkStorage = (() => {
  const PREFIX = 'mindlink_';

  function key(name) { return PREFIX + name; }
  
  // ── IndexedDB Helper (Stability for large RAG data) ──
  const DB_NAME = 'MindLinkDB';
  const DB_VERSION = 7;
  const STORE_NAME = 'reflections';
  const TOKEN_STORE = 'secure_tokens';
  const DAILY_SUMMARY_STORE = 'daily_summary';
  const LIKED_MESSAGES_STORE = 'likedMessages';
  const LIKED_STYLE_SUMMARIES_STORE = 'likedStyleSummaries';
  const FITNESS_LOGS_STORE = 'fitnessLogs';
  const FITNESS_MENUS_STORE = 'fitnessMenus';
  // アーカイブ済みスレッドの会話本文を保管する倉庫（localStorage容量対策）
  // keyPath は threadId（= スレッドID）。値は { id, messages: [...] }。
  const ARCHIVED_MESSAGES_STORE = 'archivedMessages';
  // 画像生成機能：参照画像ライブラリ（最大5枚）と生成画像本体（7日で自動整理）
  // 画像本体は容量が大きいためlocalStorageではなくIndexedDBに保管し、
  // メッセージ側には参照ID（imageId）のみを持たせる。
  const REFERENCE_IMAGES_STORE = 'referenceImages';
  const GENERATED_IMAGES_STORE = 'generatedImages';
  let _db = null;

  async function openDB() {
    if (_db) return _db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(TOKEN_STORE)) {
          db.createObjectStore(TOKEN_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(DAILY_SUMMARY_STORE)) {
          db.createObjectStore(DAILY_SUMMARY_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(LIKED_MESSAGES_STORE)) {
          db.createObjectStore(LIKED_MESSAGES_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(LIKED_STYLE_SUMMARIES_STORE)) {
          db.createObjectStore(LIKED_STYLE_SUMMARIES_STORE, { keyPath: 'date' });
        }
        if (!db.objectStoreNames.contains(FITNESS_LOGS_STORE)) {
          db.createObjectStore(FITNESS_LOGS_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(FITNESS_MENUS_STORE)) {
          db.createObjectStore(FITNESS_MENUS_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(ARCHIVED_MESSAGES_STORE)) {
          db.createObjectStore(ARCHIVED_MESSAGES_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(REFERENCE_IMAGES_STORE)) {
          db.createObjectStore(REFERENCE_IMAGES_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(GENERATED_IMAGES_STORE)) {
          db.createObjectStore(GENERATED_IMAGES_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      request.onerror = (e) => { console.error('IDB open error:', e); reject(e); };
    });
  }

  async function idbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(item) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(item);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPutMany(items) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      let count = 0;
      items.forEach(item => {
        const req = store.put(item);
        req.onsuccess = () => {
          count++;
          if (count === items.length) resolve(true);
        };
        req.onerror = () => reject(req.error);
      });
      if (items.length === 0) resolve(true);
    });
  }

  async function idbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // Tokens (Refresh Tokens etc)
  async function idbSetToken(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TOKEN_STORE, 'readwrite');
      const store = tx.objectStore(TOKEN_STORE);
      const req = store.put({ key, value, updatedAt: Date.now() });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetToken(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TOKEN_STORE, 'readonly');
      const store = tx.objectStore(TOKEN_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result?.value || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDeleteToken(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TOKEN_STORE, 'readwrite');
      const store = tx.objectStore(TOKEN_STORE);
      const req = store.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // ── Daily Summary IDB Helpers ──
  async function idbGetDailySummaryRecord() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DAILY_SUMMARY_STORE, 'readonly');
      const store = tx.objectStore(DAILY_SUMMARY_STORE);
      const req = store.get('today');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSaveDailySummaryRecord(content, date) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DAILY_SUMMARY_STORE, 'readwrite');
      const store = tx.objectStore(DAILY_SUMMARY_STORE);
      const req = store.put({ id: 'today', content, date, updatedAt: Date.now() });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDeleteDailySummaryRecord() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DAILY_SUMMARY_STORE, 'readwrite');
      const store = tx.objectStore(DAILY_SUMMARY_STORE);
      const req = store.delete('today');
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  function get(name, defaultValue = null) {
    try {
      const raw = localStorage.getItem(key(name));
      if (raw === null) return defaultValue;
      return JSON.parse(raw);
    } catch (e) {
      console.warn('Storage get error:', name, e);
      return defaultValue;
    }
  }

  function set(name, value) {
    try {
      localStorage.setItem(key(name), JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('Storage set error:', name, e);
      return false;
    }
  }

  function remove(name) {
    localStorage.removeItem(key(name));
  }

  function clear() {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  }

  // ── Auth ──
  function getAuth() {
    return get('auth', null);
  }
  function setAuth(authData) {
    return set('auth', authData);
  }
  function isFirstRun() {
    return getAuth() === null;
  }

  // ── Settings ──
  const DEFAULT_SETTINGS = {
    temperature: 0.7,
    maxTokens: 8192,
    autoLockMinutes: 15,
    theme: 'system',
    colorTheme: 'default',
    fontSize: 14,
    encryptedApiKey: null,
    encryptedGoogleServicesApiKey: null,
    userName: 'あなた',
    userAvatar: '👤',
    userBio: '',
    googleClientId: '',
    googleClientSecret: '',
    summaryModel: 'gemini-3.1-flash-lite',
    // ── 画像生成設定 ──
    imageModel: 'gemini-3.1-flash-image',  // Nano Banana 2
    imageAspectRatio: '1:1',
    imageResolution: '2K',
  };

  function getSettings() {
    return { ...DEFAULT_SETTINGS, ...get('settings', {}) };
  }
  function setSettings(settings) {
    return set('settings', settings);
  }
  function updateSettings(partial) {
    const current = getSettings();
    return setSettings({ ...current, ...partial });
  }

  // ── Threads ──
  function getThreads() {
    return get('threads', []);
  }
  function setThreads(threads) {
    return set('threads', threads);
  }
  function getThread(id) {
    return getThreads().find(t => t.id === id) || null;
  }
  function saveThread(thread) {
    const threads = getThreads();
    const idx = threads.findIndex(t => t.id === thread.id);
    if (idx >= 0) {
      threads[idx] = thread;
    } else {
      threads.unshift(thread);
    }
    return setThreads(threads);
  }
  function deleteThread(id) {
    const threads = getThreads().filter(t => t.id !== id);
    setThreads(threads);
    remove('messages_' + id);
    // アーカイブ倉庫（IndexedDB）側にも本文が残っている場合があるため掃除（best-effort）
    idbDeleteArchivedMessages(id).catch(() => {});
  }

  // ── アーカイブ会話の IndexedDB 倉庫（localStorage容量対策） ──
  // 会話本文を { id: threadId, messages: [...] } として保管する。
  async function idbPutArchivedMessages(threadId, messages) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ARCHIVED_MESSAGES_STORE, 'readwrite');
      const store = tx.objectStore(ARCHIVED_MESSAGES_STORE);
      const req = store.put({ id: threadId, messages: messages || [] });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGetArchivedMessages(threadId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ARCHIVED_MESSAGES_STORE, 'readonly');
      const store = tx.objectStore(ARCHIVED_MESSAGES_STORE);
      const req = store.get(threadId);
      req.onsuccess = () => resolve(req.result ? (req.result.messages || []) : null);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbDeleteArchivedMessages(threadId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ARCHIVED_MESSAGES_STORE, 'readwrite');
      const store = tx.objectStore(ARCHIVED_MESSAGES_STORE);
      const req = store.delete(threadId);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // アーカイブ済みスレッドの会話本文を取得する（移行後はIDB、未移行はlocalStorageから）。
  // 移行の過渡期でも確実に読めるよう、IDB→localStorage の順でフォールバックする。
  async function getArchivedMessages(threadId) {
    try {
      const fromIdb = await idbGetArchivedMessages(threadId);
      if (fromIdb !== null) return fromIdb;
    } catch (e) {
      console.warn('[MindLink] idbGetArchivedMessages failed, fallback to localStorage:', e);
    }
    return getMessages(threadId);
  }

  // localStorage にまだ会話本文が残っているアーカイブ済みスレッドのID一覧を返す（移行対象の検出用）。
  function getUnmigratedArchivedThreadIds() {
    return getThreads()
      .filter(t => t && t.isArchived && localStorage.getItem(key('messages_' + t.id)) !== null)
      .map(t => t.id);
  }

  // ── スレッドのエクスポート（読み取りのみ・既存データは一切変更しない） ──
  // アーカイブ済み（isArchived: true）のスレッドを、会話本文ごと1つのオブジェクトに
  // まとめて返す。会話本文は移行後はIndexedDBから、未移行はlocalStorageから取得する。
  async function exportArchivedThreads() {
    const archived = getThreads().filter(t => t && t.isArchived);
    const threads = [];
    for (const t of archived) {
      const messages = await getArchivedMessages(t.id);
      threads.push({ ...t, messages: messages || [] });
    }
    return {
      format: 'mindlink-archive-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: (typeof CACHE_NAME !== 'undefined') ? CACHE_NAME : 'unknown',
      threadCount: threads.length,
      threads,
    };
  }

  // ── アーカイブの一括インポート ──
  // エクスポートしたJSON（exportArchivedThreads の出力）を取り込む。
  // ・取り込んだスレッドは必ずアーカイブ状態（isArchived: true）で入る
  // ・会話本文は IndexedDB倉庫へ、メタ情報は localStorage の threads へ
  // ・既存と同じスレッドIDは取り込まずスキップ（A案：重複・上書き防止）
  // 戻り値: { total, imported, skipped }
  async function importArchivedThreads(data) {
    if (!data || data.format !== 'mindlink-archive-export' || !Array.isArray(data.threads)) {
      throw new Error('対応していないファイル形式です');
    }
    const existingIds = new Set(getThreads().map(t => t.id));
    let imported = 0;
    let skipped = 0;
    for (const entry of data.threads) {
      if (!entry || typeof entry !== 'object' || !entry.id) { skipped++; continue; }
      const id = entry.id;
      if (existingIds.has(id)) { skipped++; continue; } // 重複はスキップ
      const messages = Array.isArray(entry.messages) ? entry.messages : [];
      try {
        // ① 会話本文を IndexedDB倉庫へ書き込み → 検証
        await idbPutArchivedMessages(id, messages);
        const check = await idbGetArchivedMessages(id);
        if (check === null || check.length !== messages.length) {
          throw new Error('IndexedDBへの書き込み検証に失敗');
        }
        // ② メタ情報を threads へ追加（messagesは除外し、必ずアーカイブ状態に固定）
        const { messages: _omit, ...meta } = entry;
        saveThread({
          ...meta,
          id,
          isArchived: true,
          createdAt: meta.createdAt || Date.now(),
          updatedAt: meta.updatedAt || Date.now(),
        });
        existingIds.add(id);
        imported++;
      } catch (e) {
        console.error('[MindLink] importArchivedThreads failed for', id, e);
        skipped++;
      }
    }
    return { total: data.threads.length, imported, skipped };
  }

  // ── Messages ──
  function getMessages(threadId) {
    return get('messages_' + threadId, []);
  }
  function setMessages(threadId, messages) {
    return set('messages_' + threadId, messages);
  }
  function addMessage(threadId, message) {
    const messages = getMessages(threadId);
    // 重複チェック（再帰呼び出しなどで同じIDが重なるのを防ぐ）
    if (!messages.find(m => m.id === message.id)) {
      messages.push(message);
      return setMessages(threadId, messages);
    }
    return true;
  }

  // ── Memories ──
  function getMemories() {
    return get('memories', []);
  }
  function setMemories(memories) {
    return set('memories', memories);
  }
  function addMemory(memory) {
    const memories = getMemories();
    memories.unshift(memory);
    return setMemories(memories);
  }
  function deleteMemory(id) {
    return setMemories(getMemories().filter(m => m.id !== id));
  }
  function updateMemory(id, partial) {
    const memories = getMemories();
    const idx = memories.findIndex(m => m.id === id);
    if (idx >= 0) {
      memories[idx] = { ...memories[idx], ...partial };
      setMemories(memories);
    }
  }

  // ── Personas ──
  const DEFAULT_PERSONAS = [];

  function getPersonas() {
    let personas = get('personas', null);
    if (!personas) {
      set('personas', DEFAULT_PERSONAS);
      return DEFAULT_PERSONAS;
    }
    // 「アシスタント」項目を無条件で削除（カスタムペルソナ運用に限定）
    const filtered = personas.filter(p => p.name !== 'アシスタント' && p.name !== 'AIアシスタント');
    if (filtered.length < personas.length) {
      set('personas', filtered);
      return filtered;
    }
    return personas;
  }
  function setPersonas(personas) {
    return set('personas', personas);
  }
  function savePersona(persona) {
    const personas = getPersonas();
    const idx = personas.findIndex(p => p.id === persona.id);
    if (idx >= 0) {
      personas[idx] = persona;
    } else {
      personas.push(persona);
    }
    return setPersonas(personas);
  }
  function deletePersona(id) {
    return setPersonas(getPersonas().filter(p => p.id !== id));
  }
  function getPersona(id) {
    return getPersonas().find(p => p.id === id) || null;
  }
  function getDefaultPersona() {
    const personas = getPersonas();
    return personas.find(p => p.isDefault) || personas[0] || DEFAULT_PERSONAS[0];
  }

  // ── Active Persona ──
  function getActivePersonaId() {
    const id = get('active_persona_id', 'default');
    const personas = getPersonas();
    // デフォルトIDかつ存在しない場合、または現在のIDが見つからない場合は先頭を使用
    if (personas.length > 0 && !personas.find(p => p.id === id)) {
      return personas[0].id;
    }
    return id;
  }
  function setActivePersonaId(id) {
    return set('active_persona_id', id);
  }
  // ── Global Context ──
  function getGlobalContext() {
    return get('global_context', '');
  }
  function setGlobalContext(contextText) {
    return set('global_context', contextText);
  }

  // ── Diary ──
  function getDiaryEntries() {
    return get('diary_entries', []);
  }
  function setDiaryEntries(entries) {
    return set('diary_entries', entries);
  }
  function saveDiaryEntry(entry) {
    const entries = getDiaryEntries();
    const idx = entries.findIndex(e => e.id === entry.id);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], ...entry, updatedAt: Date.now() };
    } else {
      entry.id = entry.id || 'diary_' + Date.now();
      entry.createdAt = entry.createdAt || Date.now();
      entry.comments = entry.comments || [];
      entries.unshift(entry);
    }
    return setDiaryEntries(entries);
  }
  function deleteDiaryEntry(id) {
    const entries = getDiaryEntries().filter(e => e.id !== id);
    return setDiaryEntries(entries);
  }
  function addDiaryComment(entryId, author, content) {
    const entries = getDiaryEntries();
    const idx = entries.findIndex(e => e.id === entryId);
    if (idx >= 0) {
      const comment = {
        id: 'comment_' + Date.now(),
        author,
        content,
        timestamp: Date.now()
      };
      entries[idx].comments.push(comment);
      return setDiaryEntries(entries);
    }
    return false;
  }
  function updateDiaryComment(entryId, commentId, content) {
    const entries = getDiaryEntries();
    const eIdx = entries.findIndex(e => e.id === entryId);
    if (eIdx >= 0) {
      const cIdx = entries[eIdx].comments.findIndex(c => c.id === commentId);
      if (cIdx >= 0) {
        entries[eIdx].comments[cIdx].content = content;
        entries[eIdx].comments[cIdx].updatedAt = Date.now();
        return setDiaryEntries(entries);
      }
    }
    return false;
  }
  function deleteDiaryComment(entryId, commentId) {
    const entries = getDiaryEntries();
    const idx = entries.findIndex(e => e.id === entryId);
    if (idx >= 0) {
      entries[idx].comments = entries[idx].comments.filter(c => c.id !== commentId);
      return setDiaryEntries(entries);
    }
    return false;
  }

  // ── Reflections (RAG Memories - Migration to IndexedDB) ──
  let _migrationDone = false;

  async function getReflections() {
    // 初回のみ localStorage からの移行チェック
    if (!_migrationDone) {
      const legacyData = get('reflections', null);
      if (legacyData && Array.isArray(legacyData)) {
        console.log('[MindLink] Migrating reflections from localStorage to IndexedDB...');
        await idbPutMany(legacyData);
        remove('reflections'); // 移行後に旧データを削除
      }
      _migrationDone = true;
    }
    return await idbGetAll();
  }

  async function saveReflection(reflection) {
    reflection.id = reflection.id || 'refl_' + Date.now();
    reflection.createdAt = reflection.createdAt || Date.now();
    reflection.updatedAt = Date.now();
    return await idbPut(reflection);
  }

  async function deleteReflection(id) {
    return await idbDelete(id);
  }

  async function updateReflection(id, partial) {
    const reflections = await getReflections();
    const item = reflections.find(r => r.id === id);
    if (item) {
      const updated = { ...item, ...partial, updatedAt: Date.now() };
      return await idbPut(updated);
    }
    return false;
  }

  // ── Data Backup & Import (Export/Import) ──
  
  async function exportRAGData() {
    const data = await getReflections();
    // セキュリティのため、ここにはAPIキー等の秘密情報は一切含まれない（省察データのみ）
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mindlink_memory_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  }

  async function importRAGData(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target.result);
          if (!Array.isArray(data)) throw new Error('Invalid format');
          
          console.log(`[MindLink] Importing ${data.length} RAG records...`);
          // バッチ処理でインサート
          await idbPutMany(data);
          resolve({ success: true, count: data.length });
        } catch (err) {
          console.error('Import error:', err);
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('File read error'));
      reader.readAsText(file);
    });
  }

  // ── 全体バックアップ（エクスポート/インポート） ──
  // 含めないもの: APIキー等の秘密情報（下記リスト）・参照画像・生成画像・
  // 一時データ（今日の会話要約・いいねバッファ）。
  const BACKUP_EXCLUDED_SETTINGS = ['encryptedApiKey', 'encryptedGoogleServicesApiKey', 'googleClientSecret'];

  async function exportFullBackup() {
    const sanitizedSettings = { ...getSettings() };
    BACKUP_EXCLUDED_SETTINGS.forEach(k => delete sanitizedSettings[k]);

    // スレッド本文: アクティブはlocalStorage、アーカイブ済みはIndexedDB倉庫から取得
    const threads = [];
    for (const t of getThreads()) {
      const messages = t.isArchived ? (await getArchivedMessages(t.id)) : getMessages(t.id);
      threads.push({ ...t, messages: messages || [] });
    }

    const data = {
      format: 'mindlink-full-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: sanitizedSettings,
      activePersonaId: get('active_persona_id', null),
      globalContext: getGlobalContext(),
      personas: getPersonas(),
      memories: getMemories(),
      threads,
      reflections: await getReflections(),
      calendarEvents: getCalendarEvents(),
      diaryEntries: getDiaryEntries(),
      fitnessLogs: await getFitnessLogs(),
      fitnessMenus: await getFitnessMenus(),
      fitnessProfile: getFitnessProfile(),
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mindlink_full_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  }

  // インポート: 形式検証のうえ、各セクションを既存の保存関数で書き戻す。
  // ・ID重複は一律スキップ（既存データを上書きしない・非破壊マージ）
  // ・設定は秘密情報キーを除いて反映（現在のAPIキー等は必ず保持される）
  // 戻り値: セクションごとの取り込み件数レポート
  async function importFullBackup(data) {
    if (!data || data.format !== 'mindlink-full-backup' || !Array.isArray(data.personas)) {
      throw new Error('対応していないファイル形式です');
    }
    const report = {};

    // ペルソナ
    {
      const existing = new Set(getPersonas().map(p => p.id));
      let n = 0;
      for (const p of (data.personas || [])) {
        if (!p || !p.id || existing.has(p.id)) continue;
        savePersona(p); existing.add(p.id); n++;
      }
      report.personas = n;
    }
    // 個別記憶
    {
      const existing = new Set(getMemories().map(m => m.id));
      let n = 0;
      for (const m of (data.memories || [])) {
        if (!m || !m.id || existing.has(m.id)) continue;
        addMemory(m); existing.add(m.id); n++;
      }
      report.memories = n;
    }
    // スレッド（本文はアーカイブ状態に応じた置き場所へ復元）
    {
      const existing = new Set(getThreads().map(t => t.id));
      let n = 0;
      for (const entry of (data.threads || [])) {
        if (!entry || typeof entry !== 'object' || !entry.id || existing.has(entry.id)) continue;
        const { messages: msgs, ...meta } = entry;
        try {
          if (meta.isArchived) {
            await idbPutArchivedMessages(meta.id, msgs || []);
          } else {
            setMessages(meta.id, msgs || []);
          }
          saveThread(meta);
          existing.add(meta.id); n++;
        } catch (e) {
          console.error('[MindLink] スレッド復元失敗:', meta.id, e);
        }
      }
      report.threads = n;
    }
    // 省察
    {
      const existingIds = new Set((await getReflections()).map(r => r.id));
      const newItems = (data.reflections || []).filter(r => r && r.id && !existingIds.has(r.id));
      if (newItems.length > 0) await idbPutMany(newItems);
      report.reflections = newItems.length;
    }
    // カレンダー
    {
      const existing = new Set(getCalendarEvents().map(e => e.id));
      let n = 0;
      for (const ev of (data.calendarEvents || [])) {
        if (!ev || !ev.id || existing.has(ev.id)) continue;
        saveCalendarEvent(ev); existing.add(ev.id); n++;
      }
      report.calendar = n;
    }
    // 日記
    {
      const existing = new Set(getDiaryEntries().map(e => e.id));
      let n = 0;
      for (const e of (data.diaryEntries || [])) {
        if (!e || !e.id || existing.has(e.id)) continue;
        saveDiaryEntry(e); existing.add(e.id); n++;
      }
      report.diary = n;
    }
    // フィットネス（記録は同日1件ルールを既存関数に任せる）
    {
      let n = 0;
      const existingLogs = new Set((await getFitnessLogs()).map(l => l.id));
      for (const l of (data.fitnessLogs || [])) {
        if (!l || !l.id || existingLogs.has(l.id)) continue;
        await saveFitnessLog(l); existingLogs.add(l.id); n++;
      }
      const existingMenus = new Set((await getFitnessMenus()).map(m => m.id));
      for (const m of (data.fitnessMenus || [])) {
        if (!m || !m.id || existingMenus.has(m.id)) continue;
        await saveFitnessMenu(m); existingMenus.add(m.id); n++;
      }
      report.fitness = n;
    }
    // 設定・その他
    {
      if (data.settings && typeof data.settings === 'object') {
        const s = { ...data.settings };
        BACKUP_EXCLUDED_SETTINGS.forEach(k => delete s[k]); // 二重の安全弁
        updateSettings(s);
      }
      if (data.fitnessProfile && typeof data.fitnessProfile === 'object') {
        setFitnessProfile(data.fitnessProfile);
      }
      // グローバルコンテキストは現在が空の場合のみ反映（非破壊）
      if (data.globalContext && !getGlobalContext()) setGlobalContext(data.globalContext);
      // アクティブペルソナは復元後に実在する場合のみ反映
      if (data.activePersonaId && getPersonas().some(p => p.id === data.activePersonaId)) {
        setActivePersonaId(data.activePersonaId);
      }
    }

    return report;
  }

  // ── Daily Summary（今日の会話要約・日中記憶補完） ──

  /**
   * 今日の会話要約を取得。翌日なら自動削除してnullを返す。
   */
  async function getDailySummary() {
    try {
      const record = await idbGetDailySummaryRecord();
      if (!record) return null;
      const today = new Date().toLocaleDateString('ja-JP');
      if (record.date !== today) {
        await idbDeleteDailySummaryRecord();
        return null;
      }
      return record.content;
    } catch (e) {
      console.warn('[MindLink] getDailySummary error:', e);
      return null;
    }
  }

  /**
   * 今日の会話要約を上書き保存。
   */
  async function saveDailySummary(content) {
    try {
      const today = new Date().toLocaleDateString('ja-JP');
      return await idbSaveDailySummaryRecord(content, today);
    } catch (e) {
      console.warn('[MindLink] saveDailySummary error:', e);
      return false;
    }
  }

  /**
   * 今日の会話要約を削除（省察完了後・手動リセット用）。
   */
  async function deleteDailySummary() {
    try {
      return await idbDeleteDailySummaryRecord();
    } catch (e) {
      console.warn('[MindLink] deleteDailySummary error:', e);
      return false;
    }
  }

  // ── Calendar Events ──
  function getCalendarEvents() {
    return get('calendar_events', []);
  }
  function setCalendarEvents(events) {
    return set('calendar_events', events);
  }
  function saveCalendarEvent(event) {
    const events = getCalendarEvents();
    const idx = events.findIndex(e => e.id === event.id);
    if (idx >= 0) {
      events[idx] = { ...events[idx], ...event, updatedAt: Date.now() };
    } else {
      event.id = event.id || 'event_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      event.createdAt = event.createdAt || Date.now();
      events.push(event);
    }
    return setCalendarEvents(events);
  }
  function deleteCalendarEvent(id) {
    return setCalendarEvents(getCalendarEvents().filter(e => e.id !== id));
  }
  function updateCalendarEvent(id, partial) {
    const events = getCalendarEvents();
    const idx = events.findIndex(e => e.id === id);
    if (idx >= 0) {
      events[idx] = { ...events[idx], ...partial, updatedAt: Date.now() };
      return setCalendarEvents(events);
    }
    return false;
  }
  function getCalendarEventsForDate(dateStr) {
    // dateStr: 'YYYY-MM-DD'
    return getCalendarEvents().filter(e => {
      if (!e.startDate) return false;
      if (e.endDate && e.endDate > e.startDate) {
        return dateStr >= e.startDate && dateStr <= e.endDate;
      }
      return e.startDate === dateStr;
    });
  }

  // ── Liked Messages & Style Summaries ──

  async function addLikedMessage(msg) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LIKED_MESSAGES_STORE, 'readwrite');
      const store = tx.objectStore(LIKED_MESSAGES_STORE);
      const getReq = store.get(msg.id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        const updated = existing
          ? { ...existing, likeCount: existing.likeCount + 1 }
          : { id: msg.id, content: msg.content, likeCount: 1, timestamp: new Date().toISOString() };
        const putReq = store.put(updated);
        putReq.onsuccess = () => resolve(updated);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function getLikedMessages() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LIKED_MESSAGES_STORE, 'readonly');
      const store = tx.objectStore(LIKED_MESSAGES_STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearLikedMessages() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LIKED_MESSAGES_STORE, 'readwrite');
      const store = tx.objectStore(LIKED_MESSAGES_STORE);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ── Fitness Logs（日次フィットネス記録・1日1件・同日上書き） ──
  async function getFitnessLogs() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FITNESS_LOGS_STORE, 'readonly');
      const req = tx.objectStore(FITNESS_LOGS_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function getFitnessLogByDate(date) {
    const logs = await getFitnessLogs();
    return logs.find(l => l.date === date) || null;
  }

  async function saveFitnessLog(log) {
    const db = await openDB();
    // 同日既存レコードがあれば id / createdAt を引き継いで上書き（1日1件）
    const existing = await getFitnessLogByDate(log.date);
    if (existing) {
      log.id = existing.id;
      log.createdAt = existing.createdAt;
    } else {
      log.id = log.id || 'fitness_' + Date.now();
      log.createdAt = log.createdAt || Date.now();
    }
    log.updatedAt = Date.now();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FITNESS_LOGS_STORE, 'readwrite');
      const req = tx.objectStore(FITNESS_LOGS_STORE).put(log);
      req.onsuccess = () => resolve(log);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteFitnessLog(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FITNESS_LOGS_STORE, 'readwrite');
      const req = tx.objectStore(FITNESS_LOGS_STORE).delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // ── Fitness Menus（登録済みメニュー：筋トレ/有酸素） ──
  async function getFitnessMenus() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FITNESS_MENUS_STORE, 'readonly');
      const req = tx.objectStore(FITNESS_MENUS_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveFitnessMenu(menu) {
    const db = await openDB();
    menu.id = menu.id || 'menu_' + Date.now();
    menu.createdAt = menu.createdAt || Date.now();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FITNESS_MENUS_STORE, 'readwrite');
      const req = tx.objectStore(FITNESS_MENUS_STORE).put(menu);
      req.onsuccess = () => resolve(menu);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteFitnessMenu(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FITNESS_MENUS_STORE, 'readwrite');
      const req = tx.objectStore(FITNESS_MENUS_STORE).delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // ── Reference Images（参照画像ライブラリ・最大5枚） ──
  const MAX_REFERENCE_IMAGES = 5;

  async function getReferenceImages() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REFERENCE_IMAGES_STORE, 'readonly');
      const req = tx.objectStore(REFERENCE_IMAGES_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveReferenceImage(image) {
    const existing = await getReferenceImages();
    const isUpdate = image.id && existing.some(r => r.id === image.id);
    if (!isUpdate && existing.length >= MAX_REFERENCE_IMAGES) {
      throw new Error(`参照画像は最大${MAX_REFERENCE_IMAGES}枚までです。不要な画像を削除してください。`);
    }
    image.id = image.id || 'ref_' + Date.now();
    image.createdAt = image.createdAt || Date.now();
    image.updatedAt = Date.now();
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REFERENCE_IMAGES_STORE, 'readwrite');
      const req = tx.objectStore(REFERENCE_IMAGES_STORE).put(image);
      req.onsuccess = () => resolve(image);
      req.onerror = () => reject(req.error);
    });
  }

  async function updateReferenceImage(id, partial) {
    const images = await getReferenceImages();
    const item = images.find(r => r.id === id);
    if (!item) return false;
    return await saveReferenceImage({ ...item, ...partial, id });
  }

  async function deleteReferenceImage(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REFERENCE_IMAGES_STORE, 'readwrite');
      const req = tx.objectStore(REFERENCE_IMAGES_STORE).delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // ── Generated Images（生成画像本体・メッセージからは imageId で参照） ──
  async function saveGeneratedImage(image) {
    image.id = image.id || 'gen_' + Date.now();
    image.createdAt = image.createdAt || Date.now();
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(GENERATED_IMAGES_STORE, 'readwrite');
      const req = tx.objectStore(GENERATED_IMAGES_STORE).put(image);
      req.onsuccess = () => resolve(image);
      req.onerror = () => reject(req.error);
    });
  }

  async function getGeneratedImage(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(GENERATED_IMAGES_STORE, 'readonly');
      const req = tx.objectStore(GENERATED_IMAGES_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteGeneratedImage(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(GENERATED_IMAGES_STORE, 'readwrite');
      const req = tx.objectStore(GENERATED_IMAGES_STORE).delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // 7日（デフォルト）を過ぎた生成画像の本体を削除する（起動時に呼ばれる）。
  // メッセージ側の参照は残るため、チャットにはプレースホルダーが表示される。
  async function cleanupOldGeneratedImages(days = 7) {
    const db = await openDB();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(GENERATED_IMAGES_STORE, 'readwrite');
      const store = tx.objectStore(GENERATED_IMAGES_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const old = (req.result || []).filter(img => img.createdAt < cutoff);
        old.forEach(img => store.delete(img.id));
        if (old.length > 0) console.log(`[MindLink] 生成画像の自動整理: ${old.length}件削除`);
        resolve(old.length);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ── Fitness Profile（身長など基本情報・専用localStorageキー） ──
  function getFitnessProfile() {
    return get('fitnessProfile', { height: null });
  }
  function setFitnessProfile(partial) {
    const current = getFitnessProfile();
    return set('fitnessProfile', { ...current, ...partial });
  }

  // ── Final Return ──

  return {
    get, set, remove, clear,
    getAuth, setAuth, isFirstRun,
    getSettings, setSettings, updateSettings,
    getThreads, setThreads, getThread, saveThread, deleteThread,
    exportArchivedThreads, importArchivedThreads,
    idbPutArchivedMessages, idbGetArchivedMessages, idbDeleteArchivedMessages,
    getArchivedMessages, getUnmigratedArchivedThreadIds,
    getMessages, setMessages, addMessage,
    getMemories, setMemories, addMemory, deleteMemory, updateMemory,
    addLikedMessage, getLikedMessages, clearLikedMessages,
    getPersonas, setPersonas, savePersona, deletePersona, getPersona, getDefaultPersona,
    getActivePersonaId, setActivePersonaId,
    getGlobalContext, setGlobalContext,
    getDiaryEntries, saveDiaryEntry, deleteDiaryEntry, addDiaryComment, updateDiaryComment, deleteDiaryComment,
    getReflections, saveReflection, deleteReflection, updateReflection,
    idbSetToken, idbGetToken, idbDeleteToken,
    exportRAGData, importRAGData,
    exportFullBackup, importFullBackup,
    getDailySummary, saveDailySummary, deleteDailySummary,
    getCalendarEvents, saveCalendarEvent, deleteCalendarEvent, updateCalendarEvent, getCalendarEventsForDate,
    getFitnessLogs, getFitnessLogByDate, saveFitnessLog, deleteFitnessLog,
    getFitnessMenus, saveFitnessMenu, deleteFitnessMenu,
    getFitnessProfile, setFitnessProfile,
    getReferenceImages, saveReferenceImage, updateReferenceImage, deleteReferenceImage,
    saveGeneratedImage, getGeneratedImage, deleteGeneratedImage, cleanupOldGeneratedImages,
  };
})();

// (Diary UI \u0026 Logic removed - replaced by calendar.js)
