/**
 * MindLink - Storage Module
 * localStorageを操作する低レベルのデータ層
 */

const MindLinkStorage = (() => {
  const PREFIX = 'mindlink_';

  function key(name) { return PREFIX + name; }
  
  // ── IndexedDB Helper (Stability for large RAG data) ──
  const DB_NAME = 'MindLinkDB';
  const DB_VERSION = 4;
  const STORE_NAME = 'reflections';
  const TOKEN_STORE = 'secure_tokens';
  const DAILY_SUMMARY_STORE = 'daily_summary';
  const LIKED_MESSAGES_STORE = 'likedMessages';
  const LIKED_STYLE_SUMMARIES_STORE = 'likedStyleSummaries';
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
    summaryModel: 'gemini-3.5-flash',
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

  async function saveLikedStyleSummary(obj) {
    // obj: { date: 'YYYY-MM-DD', summary: string }
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LIKED_STYLE_SUMMARIES_STORE, 'readwrite');
      const store = tx.objectStore(LIKED_STYLE_SUMMARIES_STORE);
      const req = store.put(obj);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function getLikedStyleSummaries() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LIKED_STYLE_SUMMARIES_STORE, 'readonly');
      const store = tx.objectStore(LIKED_STYLE_SUMMARIES_STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 重みが threshold 以下の likedStyleSummaries を IndexedDB から削除
  async function pruneOldLikedStyleSummaries(threshold = 0.09) {
    const summaries = await getLikedStyleSummaries();
    if (!summaries || summaries.length === 0) return;
    const now = Date.now();
    const toDelete = summaries.filter(s => {
      const weight = 1 / ((now - new Date(s.date)) / 86400000 + 1);
      return weight <= threshold;
    });
    if (toDelete.length === 0) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LIKED_STYLE_SUMMARIES_STORE, 'readwrite');
      const store = tx.objectStore(LIKED_STYLE_SUMMARIES_STORE);
      let completed = 0;
      for (const s of toDelete) {
        const req = store.delete(s.date);
        req.onsuccess = () => {
          completed++;
          if (completed === toDelete.length) resolve(toDelete.length);
        };
        req.onerror = () => reject(req.error);
      }
    });
  }

  // ── Final Return ──

  return {
    get, set, remove, clear,
    getAuth, setAuth, isFirstRun,
    getSettings, setSettings, updateSettings,
    getThreads, setThreads, getThread, saveThread, deleteThread,
    getMessages, setMessages, addMessage,
    getMemories, setMemories, addMemory, deleteMemory, updateMemory,
    addLikedMessage, getLikedMessages, clearLikedMessages,
    saveLikedStyleSummary, getLikedStyleSummaries, pruneOldLikedStyleSummaries,
    getPersonas, setPersonas, savePersona, deletePersona, getPersona, getDefaultPersona,
    getActivePersonaId, setActivePersonaId,
    getGlobalContext, setGlobalContext,
    getDiaryEntries, saveDiaryEntry, deleteDiaryEntry, addDiaryComment, updateDiaryComment, deleteDiaryComment,
    getReflections, saveReflection, deleteReflection, updateReflection,
    idbSetToken, idbGetToken, idbDeleteToken,
    exportRAGData, importRAGData,
    getDailySummary, saveDailySummary, deleteDailySummary,
    getCalendarEvents, saveCalendarEvent, deleteCalendarEvent, updateCalendarEvent, getCalendarEventsForDate,
  };
})();

// (Diary UI \u0026 Logic removed - replaced by calendar.js)
