/**
 * MindLink - Memory Module
 * 記憶機能の管理
 */

const MindLinkMemory = (() => {
  let _pendingSuggestion = null;
  let _suggestionTimeout = null;

  function generateId() {
    return 'mem_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  // 記憶追加
  function addMemory(content, category = 'other', tags = [], addedBy = 'user') {
    if (!content.trim()) return null;
    const memory = {
      id: generateId(),
      content: content.trim(),
      category,
      tags: tags.filter(t => t.trim()),
      addedBy,
      createdAt: Date.now(),
    };
    MindLinkStorage.addMemory(memory);
    return memory;
  }

  // カテゴリ名 → 表示名
  function getCategoryLabel(category) {
    const labels = {
      profile: 'プロフィール',
      preference: '好み',
      knowledge: '知識',
      other: 'その他',
    };
    return labels[category] || 'その他';
  }

  // 記憶一覧描画
  function renderMemoryList(filter = 'all') {
    const listEl = document.getElementById('memory-list');
    if (!listEl) return;

    let memories = MindLinkStorage.getMemories();
    if (filter !== 'all') {
      memories = memories.filter(m => m.category === filter);
    }

    if (memories.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p>記憶がありません。会話中に「記憶に追加」ボタンで保存できます。</p></div>';
      return;
    }

    listEl.innerHTML = '';
    memories.forEach(m => {
      const div = document.createElement('div');
      div.className = 'memory-item';
      div.dataset.memoryId = m.id;
      div.innerHTML = `
        <div class="memory-item-body">
          <div class="memory-item-content">${escapeHtml(m.content)}</div>
          <div class="memory-item-meta">
            <span class="memory-category-badge category-${m.category}">${getCategoryLabel(m.category)}</span>
            ${m.tags.map(t => `<span>#${escapeHtml(t)}</span>`).join('')}
            <span>${new Date(m.createdAt).toLocaleDateString('ja-JP')}</span>
            <span>${m.addedBy === 'ai' ? '🤖 AI提案' : '👤 手動'}</span>
          </div>
        </div>
        <div class="memory-item-actions">
          <button class="btn-icon memory-edit-btn" data-id="${m.id}" title="編集">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
          <button class="btn-icon memory-delete-btn" data-id="${m.id}" title="削除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
            </svg>
          </button>
        </div>
      `;
      div.querySelector('.memory-edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(m);
      });
      div.querySelector('.memory-delete-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        MindLinkApp.showConfirm('記憶を削除', 'この記憶を削除してもよろしいですか？', () => {
          MindLinkStorage.deleteMemory(m.id);
          renderMemoryList(filter);
          MindLinkApp.showToast('記憶を削除しました');
        });
      });
      listEl.appendChild(div);
    });
  }

  function openEditModal(memory) {
    document.getElementById('edit-memory-id').value = memory.id;
    document.getElementById('edit-memory-content').value = memory.content;
    document.getElementById('edit-memory-category').value = memory.category || 'other';
    document.getElementById('edit-memory-tags').value = (memory.tags || []).join(', ');
    
    // show modal
    document.getElementById('edit-memory-modal')?.classList.add('active');
  }

  // AI提案処理
  function showMemorySuggestion(suggestion) {
    _pendingSuggestion = suggestion;
    const toast = document.getElementById('memory-suggestion-toast');
    const textEl = document.getElementById('toast-memory-text');
    if (!toast || !textEl) return;
    textEl.textContent = suggestion;
    toast.classList.add('active');

    // 10秒後に自動的に消える
    if (_suggestionTimeout) clearTimeout(_suggestionTimeout);
    _suggestionTimeout = setTimeout(() => {
      hideMemorySuggestion();
    }, 10000);
  }

  function hideMemorySuggestion() {
    const toast = document.getElementById('memory-suggestion-toast');
    toast?.classList.remove('active');
    _pendingSuggestion = null;
  }

  function acceptMemorySuggestion() {
    if (_pendingSuggestion) {
      addMemory(_pendingSuggestion, 'other', [], 'ai');
      MindLinkApp.showToast('記憶に追加しました 🧠');
    }
    hideMemorySuggestion();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  return {
    addMemory,
    getCategoryLabel,
    renderMemoryList,
    showMemorySuggestion,
    hideMemorySuggestion,
    acceptMemorySuggestion,
  };
})();

window.MindLinkMemory = MindLinkMemory;
