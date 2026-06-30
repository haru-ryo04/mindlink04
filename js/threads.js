/**
 * MindLink - Threads Module
 * スレッド（会話）の管理
 */

const MindLinkThreads = (() => {
  let _currentThreadId = null;

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  function getCurrentThreadId() { return _currentThreadId; }
  function setCurrentThreadId(id) { _currentThreadId = id; }

  // UIで選択中のモデルを一時保持（スレッド未作成でも選択を覚えておく）
  // createThread がこの値を使うため、新規チャットでも選択が確実に反映される。
  function getPendingModel() {
    return MindLinkStorage.get('pendingModel', 'gemini-3.5-flash');
  }
  function setPendingModel(model) {
    return MindLinkStorage.set('pendingModel', model);
  }

  // スレッド作成
  function createThread(personaId) {
    const thread = {
      id: generateId(),
      title: '新しいチャット',
      personaId: personaId || MindLinkStorage.getActivePersonaId(),
      model: getPendingModel(),
      isPinned: false,
      isArchived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
    };
    MindLinkStorage.saveThread(thread);
    return thread;
  }

  // タイトル更新
  function updateThreadTitle(id, title) {
    const thread = MindLinkStorage.getThread(id);
    if (!thread) return;
    MindLinkStorage.saveThread({ ...thread, title, updatedAt: Date.now() });
  }

  // ピン留めトグル
  function togglePin(id) {
    const thread = MindLinkStorage.getThread(id);
    if (!thread) return;
    MindLinkStorage.saveThread({ ...thread, isPinned: !thread.isPinned, updatedAt: Date.now() });
  }

  // アーカイブ：会話本文を localStorage → IndexedDB倉庫 へ移動して容量を空ける。
  // データが消える瞬間が無いよう「IDBに書く→検証→メタ更新→最後にlocalStorage削除」の順。
  async function archiveThread(id) {
    const thread = MindLinkStorage.getThread(id);
    if (!thread) return false;
    if (thread.isArchived) return true; // 既にアーカイブ済み
    try {
      // ① localStorage から会話本文を読む
      const messages = MindLinkStorage.getMessages(id);
      // ② IndexedDB に書き込む
      await MindLinkStorage.idbPutArchivedMessages(id, messages);
      // ③ 書き込めたか検証（読み返して件数一致を確認）
      const check = await MindLinkStorage.idbGetArchivedMessages(id);
      if (check === null || check.length !== messages.length) {
        throw new Error('IndexedDBへの書き込み検証に失敗');
      }
      // ④⑤ メタ情報を isArchived: true に更新
      MindLinkStorage.saveThread({ ...thread, isArchived: true, updatedAt: Date.now() });
      // ⑥ 最後に localStorage の元データを削除（ここで初めて容量が空く）
      MindLinkStorage.remove('messages_' + id);
      if (_currentThreadId === id) _currentThreadId = null;
      return true;
    } catch (e) {
      console.error('[MindLink] archiveThread failed:', e);
      if (window.MindLinkApp) window.MindLinkApp.showToast('アーカイブに失敗しました');
      return false;
    }
  }

  // アーカイブから復元：会話本文を IndexedDB倉庫 → localStorage へ書き戻す。
  // localStorageが満杯で書き戻せない場合は中止し、アーカイブのまま維持する。
  async function restoreThread(id) {
    const thread = MindLinkStorage.getThread(id);
    if (!thread) return false;
    if (!thread.isArchived) return true;
    try {
      // ① IDB倉庫から会話本文を読む（無ければlocalStorageフォールバック）
      const messages = await MindLinkStorage.getArchivedMessages(id);
      // ② localStorage に書き戻す（満杯なら set は false を返す）
      const ok = MindLinkStorage.setMessages(id, messages || []);
      if (!ok) {
        if (window.MindLinkApp) window.MindLinkApp.showToast('容量不足で復元できません。アーカイブのまま維持します');
        return false;
      }
      // ③ メタ情報を isArchived: false に更新
      MindLinkStorage.saveThread({ ...thread, isArchived: false, updatedAt: Date.now() });
      // ④ IDB倉庫側を削除
      await MindLinkStorage.idbDeleteArchivedMessages(id);
      return true;
    } catch (e) {
      console.error('[MindLink] restoreThread failed:', e);
      if (window.MindLinkApp) window.MindLinkApp.showToast('復元に失敗しました');
      return false;
    }
  }

  // 削除
  function deleteThread(id) {
    MindLinkStorage.deleteThread(id);
    if (_currentThreadId === id) {
      _currentThreadId = null;
    }
  }

  // モデル更新
  function updateThreadModel(id, model) {
    const thread = MindLinkStorage.getThread(id);
    if (!thread) return;
    MindLinkStorage.saveThread({ ...thread, model, updatedAt: Date.now() });
  }

  // 更新タイムスタンプ更新
  function touchThread(id) {
    const thread = MindLinkStorage.getThread(id);
    if (!thread) return;
    MindLinkStorage.saveThread({ ...thread, updatedAt: Date.now(), messageCount: (thread.messageCount || 0) + 1 });
  }

  // 日時フォーマット
  function formatDate(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const day = 86400000;
    if (diff < 60000) return 'たった今';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
    if (diff < day) return `${Math.floor(diff / 3600000)}時間前`;
    if (diff < day * 7) return `${Math.floor(diff / day)}日前`;
    return new Date(timestamp).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
  }

  // スレッドリスト描画
  function renderThreadList(searchQuery = '') {
    const listEl = document.getElementById('thread-list');
    if (!listEl) return;

    const threads = MindLinkStorage.getThreads().filter(t => !t.isArchived);
    const personas = MindLinkStorage.getPersonas();

    const query = searchQuery.toLowerCase();
    const filtered = query
      ? threads.filter(t => t.title.toLowerCase().includes(query))
      : threads;

    const pinned = filtered.filter(t => t.isPinned);
    const recent = filtered.filter(t => !t.isPinned);

    listEl.innerHTML = '';

    if (pinned.length > 0) {
      const label = document.createElement('div');
      label.className = 'thread-section-label';
      label.textContent = 'ピン留め';
      listEl.appendChild(label);
      pinned.forEach(t => listEl.appendChild(createThreadItem(t, personas)));
    }

    if (recent.length > 0) {
      if (pinned.length > 0) {
        const label = document.createElement('div');
        label.className = 'thread-section-label';
        label.textContent = '最近';
        listEl.appendChild(label);
      }
      recent.forEach(t => listEl.appendChild(createThreadItem(t, personas)));
    }

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p>チャットがありません</p></div>';
    }
  }

  function createThreadItem(thread, personas) {
    const persona = personas.find(p => p.id === thread.personaId) || personas[0];
    const div = document.createElement('div');
    div.className = 'thread-item' + (thread.id === _currentThreadId ? ' active' : '') + (thread.isPinned ? ' pinned' : '');
    div.dataset.threadId = thread.id;

    let avatarHtml = persona?.avatar || '🌙';
    if (avatarHtml.startsWith('data:image')) {
      avatarHtml = `<div class="avatar-img-inline" style="background-image: url(${avatarHtml}); border-radius:50%; width:28px; height:28px; background-size:cover; background-position:center; display:inline-block; vertical-align:middle;"></div>`;
    }

    div.innerHTML = `
      <div class="thread-item-avatar" style="display:flex; align-items:center; justify-content:center;">${avatarHtml}</div>
      <div class="thread-item-body">
        <div class="thread-item-title">${escapeHtml(thread.title)}</div>
        <div class="thread-item-date">${formatDate(thread.updatedAt)}</div>
      </div>
    `;

    div.addEventListener('click', () => {
      window.MindLinkApp?.selectThread(thread.id);
    });

    return div;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // エクスポート（Markdown形式）
  function exportThread(threadId) {
    const thread = MindLinkStorage.getThread(threadId);
    if (!thread) return;
    const messages = MindLinkStorage.getMessages(threadId);
    const persona = MindLinkStorage.getPersona(thread.personaId);

    let md = `# ${thread.title}\n\n`;
    md += `**ペルソナ**: ${persona?.name || '不明'}\n`;
    md += `**作成日**: ${new Date(thread.createdAt).toLocaleString('ja-JP')}\n\n---\n\n`;

    const avatarStr = (persona?.avatar && persona.avatar.startsWith('data:image')) ? '🖼️' : (persona?.avatar || '🌙');

    messages.forEach(msg => {
      const role = msg.role === 'user' ? '👤 あなた' : `${avatarStr} ${persona?.name || 'AI'}`;
      md += `**${role}**\n\n${msg.content}\n\n---\n\n`;
    });

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mindlink-${thread.title.slice(0, 20)}-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // アーカイブ一覧描画
  function renderArchiveList() {
    const listEl = document.getElementById('archive-list');
    if (!listEl) return;
    const archived = MindLinkStorage.getThreads().filter(t => t.isArchived);

    if (archived.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p>アーカイブされたチャットはありません</p></div>';
      return;
    }

    listEl.innerHTML = '';
    archived.forEach(t => {
      const div = document.createElement('div');
      div.className = 'archive-item';
      div.innerHTML = `
        <div class="archive-item-body">
          <div class="archive-item-title">${escapeHtml(t.title)}</div>
          <div class="archive-item-date">${new Date(t.updatedAt).toLocaleDateString('ja-JP')}</div>
        </div>
        <div class="archive-item-actions">
          <button class="btn-restore" data-id="${t.id}">復元</button>
          <button class="btn-icon memory-delete-btn" data-del-id="${t.id}" title="削除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
          </button>
        </div>
      `;
      div.querySelector('.archive-item-body').addEventListener('click', () => {
        if (window.MindLinkApp) {
          window.MindLinkApp.selectThread(t.id);
          window.MindLinkApp.closeModal('archive-modal');
        }
      });
      div.querySelector('.archive-item-body').style.cursor = 'pointer';
      
      div.querySelector('.btn-restore').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await restoreThread(t.id);
        renderArchiveList();
        renderThreadList();
        // 失敗時は restoreThread 内で個別のトーストを出すため、成功時のみ表示
        if (ok && window.MindLinkApp) window.MindLinkApp.showToast('チャットを復元しました');
      });
      div.querySelector('.memory-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteThread(t.id);
        renderArchiveList();
        if (window.MindLinkApp) window.MindLinkApp.showToast('削除しました');
      });
      listEl.appendChild(div);
    });
  }

  return {
    generateId,
    getCurrentThreadId,
    setCurrentThreadId,
    getPendingModel,
    setPendingModel,
    createThread,
    updateThreadTitle,
    togglePin,
    archiveThread,
    restoreThread,
    deleteThread,
    updateThreadModel,
    touchThread,
    formatDate,
    renderThreadList,
    renderArchiveList,
    exportThread,
  };
})();

window.MindLinkThreads = MindLinkThreads;
