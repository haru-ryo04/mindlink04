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

  // スレッド作成
  function createThread(personaId) {
    const thread = {
      id: generateId(),
      title: '新しいチャット',
      personaId: personaId || MindLinkStorage.getActivePersonaId(),
      model: 'gemini-3.5-flash',
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

  // アーカイブ
  function archiveThread(id) {
    const thread = MindLinkStorage.getThread(id);
    if (!thread) return;
    MindLinkStorage.saveThread({ ...thread, isArchived: true, updatedAt: Date.now() });
    if (_currentThreadId === id) {
      _currentThreadId = null;
    }
  }

  // アーカイブから復元
  function restoreThread(id) {
    const thread = MindLinkStorage.getThread(id);
    if (!thread) return;
    MindLinkStorage.saveThread({ ...thread, isArchived: false, updatedAt: Date.now() });
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
      
      div.querySelector('.btn-restore').addEventListener('click', (e) => {
        e.stopPropagation();
        restoreThread(t.id);
        renderArchiveList();
        renderThreadList();
        if (window.MindLinkApp) window.MindLinkApp.showToast('チャットを復元しました');
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
