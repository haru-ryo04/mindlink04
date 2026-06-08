/**
 * MindLink - Calendar Module
 * アプリ内カレンダー・予定管理（絵文字ベースUI）
 */

const MindLinkCalendar = (() => {
  let _currentYear = new Date().getFullYear();
  let _currentMonth = new Date().getMonth();
  let _selectedDate = null; // 'YYYY-MM-DD'
  let _editingEventId = null;

  // ── 絵文字ピッカー定義 ──
  const EMOJI_CATEGORIES = [
    { label: '生活', emojis: ['🏠', '🛒', '🍽️', '☕', '🛁', '🧹', '🧺', '💊', '🚗', '🚌'] },
    { label: '仕事・学習', emojis: ['💼', '📚', '📝', '💻', '📊', '🎯', '📌', '📞', '✉️', '🔑'] },
    { label: '健康・運動', emojis: ['🏃', '🧘', '🏋️', '🚴', '🏊', '⚽', '🎾', '🧗', '🩺', '💉'] },
    { label: 'イベント・レジャー', emojis: ['🎉', '🎂', '🎁', '🎊', '🎵', '🎬', '🎮', '🎨', '🌸', '🍻'] },
    { label: '旅行・外出', emojis: ['✈️', '🚀', '🚂', '⛵', '🏖️', '🗺️', '🏕️', '🌍', '🎡', '🗼'] },
    { label: 'その他', emojis: ['⭐', '🌟', '❤️', '🔥', '✅', '⚡', '🌈', '📅', '🕐', '🔔'] },
  ];

  // ── utils ──
  function toDateStr(year, month, day) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function parseDateStr(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function formatDateJa(dateStr) {
    const d = parseDateStr(dateStr);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function todayStr() {
    const n = new Date();
    return toDateStr(n.getFullYear(), n.getMonth(), n.getDate());
  }

  // ── カレンダーを開く ──
  function openCalendarModal() {
    _currentYear = new Date().getFullYear();
    _currentMonth = new Date().getMonth();
    _selectedDate = todayStr();
    document.getElementById('calendar-modal')?.classList.add('active');
    renderCalendar();
    renderDayView(_selectedDate);
  }

  // ── カレンダーグリッド描画 ──
  function renderCalendar() {
    const grid = document.getElementById('cal-grid');
    const title = document.getElementById('cal-title');
    if (!grid || !title) return;

    title.textContent = `${_currentYear}年 ${_currentMonth + 1}月`;
    grid.innerHTML = '';

    // 曜日ラベル
    ['日', '月', '火', '水', '木', '金', '土'].forEach((l, i) => {
      const el = document.createElement('div');
      el.className = 'cal-day-label' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '');
      el.textContent = l;
      grid.appendChild(el);
    });

    const firstDay = new Date(_currentYear, _currentMonth, 1).getDay();
    const lastDate = new Date(_currentYear, _currentMonth + 1, 0).getDate();
    const prevLastDate = new Date(_currentYear, _currentMonth, 0).getDate();
    const today = todayStr();
    const allEvents = MindLinkStorage.getCalendarEvents();

    // 前月の余白
    for (let i = firstDay; i > 0; i--) {
      const el = document.createElement('div');
      el.className = 'cal-day other-month';
      el.textContent = prevLastDate - i + 1;
      grid.appendChild(el);
    }

    // 当月
    for (let d = 1; d <= lastDate; d++) {
      const dateStr = toDateStr(_currentYear, _currentMonth, d);
      const isToday = dateStr === today;
      const isSelected = dateStr === _selectedDate;

      const el = document.createElement('div');
      el.className = `cal-day${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`;

      // 数字
      const numEl = document.createElement('span');
      numEl.className = 'cal-day-num';
      numEl.textContent = d;
      el.appendChild(numEl);

      // 絵文字（この日の予定）
      const dayEvents = allEvents.filter(e => {
        if (!e.startDate) return false;
        const end = e.endDate || e.startDate;
        return dateStr >= e.startDate && dateStr <= end;
      });

      if (dayEvents.length > 0) {
        const emojiContainer = document.createElement('div');
        emojiContainer.className = 'cal-emojis';
        // 最大3個まで表示
        dayEvents.slice(0, 3).forEach(ev => {
          const eEl = document.createElement('span');
          eEl.className = 'cal-emoji';
          eEl.textContent = ev.emoji || '📅';
          emojiContainer.appendChild(eEl);
        });
        el.appendChild(emojiContainer);
      }

      el.addEventListener('click', () => {
        _selectedDate = dateStr;
        renderCalendar();
        renderDayView(dateStr);
      });

      grid.appendChild(el);
    }
  }

  // ── 日付詳細ビュー ──
  function renderDayView(dateStr) {
    const view = document.getElementById('cal-day-view');
    if (!view) return;

    const events = MindLinkStorage.getCalendarEventsForDate(dateStr);
    const dateLabel = formatDateJa(dateStr);

    view.innerHTML = `
      <div class="cal-day-header">
        <h3 class="cal-day-title">📅 ${dateLabel}</h3>
        <button class="btn-primary btn-sm" id="btn-add-cal-event">＋ 予定を追加</button>
      </div>
      <div id="cal-events-list" class="cal-events-list"></div>
    `;

    document.getElementById('btn-add-cal-event')?.addEventListener('click', () => {
      openAddEventModal(dateStr);
    });

    const list = document.getElementById('cal-events-list');
    if (events.length === 0) {
      list.innerHTML = `<div class="cal-empty-state">この日の予定はありません</div>`;
      return;
    }

    events.forEach(ev => {
      const card = document.createElement('div');
      card.className = 'cal-event-card';

      const timeStr = ev.isAllDay ? '終日' :
        (ev.startTime ? ev.startTime + (ev.endTime ? ` 〜 ${ev.endTime}` : '') : '');
      const spanStr = (ev.endDate && ev.endDate !== ev.startDate) ?
        `<span class="cal-event-span">${formatDateJa(ev.startDate)} 〜 ${formatDateJa(ev.endDate)}</span>` : '';
      const createdByStr = ev.createdBy === 'ai' ? '<span class="cal-event-badge">AI</span>' : '';

      card.innerHTML = `
        <div class="cal-event-emoji">${ev.emoji || '📅'}</div>
        <div class="cal-event-info">
          <div class="cal-event-title">${escapeHtml(ev.title || '')} ${createdByStr}</div>
          ${timeStr ? `<div class="cal-event-time">${escapeHtml(timeStr)}</div>` : ''}
          ${spanStr}
          ${ev.description ? `<div class="cal-event-desc">${escapeHtml(ev.description)}</div>` : ''}
        </div>
        <div class="cal-event-actions">
          <button class="cal-action-btn" data-edit="${ev.id}" title="編集">✏️</button>
          <button class="cal-action-btn danger" data-delete="${ev.id}" title="削除">🗑️</button>
        </div>
      `;

      card.querySelector(`[data-edit="${ev.id}"]`)?.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditEventModal(ev.id);
      });
      card.querySelector(`[data-delete="${ev.id}"]`)?.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteEvent(ev.id, dateStr);
      });

      list.appendChild(card);
    });
  }

  // ── 予定追加モーダルを開く ──
  function openAddEventModal(defaultDate) {
    _editingEventId = null;
    document.getElementById('event-modal-title').textContent = '予定を追加';
    document.getElementById('event-emoji-input').value = '';
    document.getElementById('event-title-input').value = '';
    document.getElementById('event-start-date').value = defaultDate || todayStr();
    document.getElementById('event-end-date').value = '';
    document.getElementById('event-start-time').value = '';
    document.getElementById('event-end-time').value = '';
    document.getElementById('event-allday').checked = false;
    document.getElementById('event-description').value = '';
    const syncCheck = document.getElementById('event-google-sync');
    if (syncCheck) syncCheck.checked = false;

    updateTimeFieldsVisibility();
    renderEmojiPicker('');
    document.getElementById('event-add-modal')?.classList.add('active');
  }

  // ── 予定編集モーダルを開く ──
  function openEditEventModal(id) {
    const events = MindLinkStorage.getCalendarEvents();
    const ev = events.find(e => e.id === id);
    if (!ev) return;

    _editingEventId = id;
    document.getElementById('event-modal-title').textContent = '予定を編集';
    document.getElementById('event-emoji-input').value = ev.emoji || '';
    document.getElementById('event-title-input').value = ev.title || '';
    document.getElementById('event-start-date').value = ev.startDate || '';
    document.getElementById('event-end-date').value = ev.endDate || '';
    document.getElementById('event-start-time').value = ev.startTime || '';
    document.getElementById('event-end-time').value = ev.endTime || '';
    document.getElementById('event-allday').checked = !!ev.isAllDay;
    document.getElementById('event-description').value = ev.description || '';
    const syncCheck = document.getElementById('event-google-sync');
    if (syncCheck) syncCheck.checked = false;

    updateTimeFieldsVisibility();
    renderEmojiPicker(ev.emoji || '');
    document.getElementById('event-add-modal')?.classList.add('active');
  }

  // ── 終日チェックで時間フィールドを切替 ──
  function updateTimeFieldsVisibility() {
    const isAllDay = document.getElementById('event-allday')?.checked;
    const timeRow = document.getElementById('event-time-row');
    if (timeRow) timeRow.style.display = isAllDay ? 'none' : '';
  }

  // ── 絵文字ピッカー描画 ──
  function renderEmojiPicker(selectedEmoji) {
    const picker = document.getElementById('emoji-picker-grid');
    if (!picker) return;
    picker.innerHTML = '';

    EMOJI_CATEGORIES.forEach(cat => {
      const catLabel = document.createElement('div');
      catLabel.className = 'emoji-cat-label';
      catLabel.textContent = cat.label;
      picker.appendChild(catLabel);

      const row = document.createElement('div');
      row.className = 'emoji-cat-row';
      cat.emojis.forEach(em => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'emoji-btn' + (em === selectedEmoji ? ' selected' : '');
        btn.textContent = em;
        btn.addEventListener('click', () => {
          document.getElementById('event-emoji-input').value = em;
          picker.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
        });
        row.appendChild(btn);
      });
      picker.appendChild(row);
    });
  }

  // ── 予定を保存 ──
  async function saveEvent() {
    const emoji = document.getElementById('event-emoji-input')?.value.trim() || '📅';
    const title = document.getElementById('event-title-input')?.value.trim();
    const startDate = document.getElementById('event-start-date')?.value;
    const endDate = document.getElementById('event-end-date')?.value || '';
    const startTime = document.getElementById('event-start-time')?.value || '';
    const endTime = document.getElementById('event-end-time')?.value || '';
    const isAllDay = document.getElementById('event-allday')?.checked || false;
    const description = document.getElementById('event-description')?.value.trim() || '';
    const syncGoogle = document.getElementById('event-google-sync')?.checked || false;

    if (!title) {
      MindLinkApp?.showToast('タイトルを入力してください');
      return;
    }
    if (!startDate) {
      MindLinkApp?.showToast('開始日を入力してください');
      return;
    }

    const eventData = {
      emoji,
      title,
      startDate,
      endDate: endDate && endDate >= startDate ? endDate : '',
      startTime: isAllDay ? '' : startTime,
      endTime: isAllDay ? '' : endTime,
      isAllDay,
      description,
      createdBy: 'user',
    };

    if (_editingEventId) {
      eventData.id = _editingEventId;
    }

    MindLinkStorage.saveCalendarEvent(eventData);

    // Googleカレンダーにも同期
    if (syncGoogle) {
      await syncToGoogle(eventData);
    }

    document.getElementById('event-add-modal')?.classList.remove('active');
    MindLinkApp?.showToast(_editingEventId ? '予定を更新しました ✏️' : '予定を追加しました 📅');
    renderCalendar();
    if (_selectedDate) renderDayView(_selectedDate);
  }

  // ── Googleカレンダー同期 ──
  async function syncToGoogle(eventData) {
    try {
      if (!window.MindLinkGoogleServices) return;
      if (!window.MindLinkGoogleAuth) return;

      const token = await MindLinkGoogleAuth.getAccessToken();
      if (!token) {
        MindLinkApp?.showToast('Googleカレンダー未連携です');
        return;
      }

      // 日時を ISO 8601 に変換
      let startISO, endISO;
      if (eventData.isAllDay) {
        startISO = eventData.startDate;
        endISO = (eventData.endDate || eventData.startDate);
      } else {
        const startDateTimeStr = eventData.startDate + 'T' + (eventData.startTime || '00:00') + ':00';
        const endDateTimeStr = (eventData.endDate || eventData.startDate) + 'T' + (eventData.endTime || eventData.startTime || '00:00') + ':00';
        startISO = new Date(startDateTimeStr).toISOString();
        endISO = new Date(endDateTimeStr).toISOString();
      }

      const gcalEvent = {
        summary: (eventData.emoji ? eventData.emoji + ' ' : '') + eventData.title,
        description: eventData.description || '',
      };

      if (eventData.isAllDay) {
        gcalEvent.start = { date: startISO };
        gcalEvent.end = { date: endISO };
      } else {
        gcalEvent.start = { dateTime: startISO };
        gcalEvent.end = { dateTime: endISO };
      }

      const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(gcalEvent)
      });

      if (response.ok) {
        MindLinkApp?.showToast('Googleカレンダーにも追加しました 📅');
      } else {
        const err = await response.json();
        console.warn('[Calendar] Google sync error:', err);
        MindLinkApp?.showToast('Google同期に失敗しました');
      }
    } catch (e) {
      console.error('[Calendar] Google sync error:', e);
      MindLinkApp?.showToast('Googleカレンダーとの同期に失敗しました');
    }
  }

  // ── Googleカレンダーからインポート ──
  async function syncFromGoogle() {
    try {
      if (!window.MindLinkGoogleAuth) return;
      const token = await MindLinkGoogleAuth.getAccessToken();
      if (!token) {
        MindLinkApp?.showToast('Googleカレンダーに未接続です。設定からGoogle連携してください。');
        return;
      }

      const now = new Date();
      const timeMin = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const timeMax = new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString();

      const resp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=50&orderBy=startTime&singleEvents=true&timeMin=${timeMin}&timeMax=${timeMax}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      if (!resp.ok) {
        MindLinkApp?.showToast('Google同期に失敗しました');
        return;
      }

      const data = await resp.json();
      const items = data.items || [];
      let added = 0;

      items.forEach(item => {
        const existEvents = MindLinkStorage.getCalendarEvents();
        // 既にgoogleEventIdで登録済みならスキップ
        if (existEvents.some(e => e.googleEventId === item.id)) return;

        const isAllDay = !item.start.dateTime;
        const startDate = isAllDay ? item.start.date : item.start.dateTime?.slice(0, 10);
        const endDateRaw = isAllDay ? item.end.date : item.end.dateTime?.slice(0, 10);
        // Googleのallday endは「翌日」なので1日引く
        let endDate = endDateRaw;
        if (isAllDay && endDate && endDate > startDate) {
          const d = new Date(endDate);
          d.setDate(d.getDate() - 1);
          endDate = d.toISOString().slice(0, 10);
        }
        const startTime = isAllDay ? '' : item.start.dateTime?.slice(11, 16);
        const endTime = isAllDay ? '' : item.end.dateTime?.slice(11, 16);

        MindLinkStorage.saveCalendarEvent({
          emoji: '📅',
          title: item.summary || '（タイトルなし）',
          description: item.description || '',
          startDate,
          endDate: (endDate && endDate !== startDate) ? endDate : '',
          startTime,
          endTime,
          isAllDay,
          createdBy: 'google',
          googleEventId: item.id,
        });
        added++;
      });

      renderCalendar();
      if (_selectedDate) renderDayView(_selectedDate);
      MindLinkApp?.showToast(`Googleカレンダーから ${added} 件の予定を同期しました`);
    } catch (e) {
      console.error('[Calendar] syncFromGoogle error:', e);
      MindLinkApp?.showToast('Googleカレンダー同期中にエラーが発生しました');
    }
  }

  // ── 予定を削除 ──
  function deleteEvent(id, currentDateStr) {
    if (!window.MindLinkApp) return;
    MindLinkApp.showConfirm('予定を削除', 'この予定を削除してもよろしいですか？', () => {
      MindLinkStorage.deleteCalendarEvent(id);
      renderCalendar();
      if (currentDateStr) renderDayView(currentDateStr);
      MindLinkApp?.showToast('予定を削除しました');
    });
  }

  // ── エスケープ ──
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── イベントリスナー初期化 ──
  function init() {
    // カレンダーボタン（サイドバー）
    document.getElementById('btn-calendar')?.addEventListener('click', () => {
      openCalendarModal();
    });

    // モーダルを閉じるボタン
    document.getElementById('cal-modal-close')?.addEventListener('click', () => {
      document.getElementById('calendar-modal')?.classList.remove('active');
    });
    document.getElementById('event-modal-close')?.addEventListener('click', () => {
      document.getElementById('event-add-modal')?.classList.remove('active');
    });

    // オーバーレイクリックで閉じる（calendar-modal）
    document.getElementById('calendar-modal')?.addEventListener('click', (e) => {
      if (e.target === document.getElementById('calendar-modal')) {
        document.getElementById('calendar-modal').classList.remove('active');
      }
    });

    // 月移動ボタン
    document.getElementById('cal-prev-btn')?.addEventListener('click', () => {
      _currentMonth--;
      if (_currentMonth < 0) { _currentMonth = 11; _currentYear--; }
      renderCalendar();
    });
    document.getElementById('cal-next-btn')?.addEventListener('click', () => {
      _currentMonth++;
      if (_currentMonth > 11) { _currentMonth = 0; _currentYear++; }
      renderCalendar();
    });

    // 終日チェックボックス
    document.getElementById('event-allday')?.addEventListener('change', updateTimeFieldsVisibility);

    // 保存ボタン
    document.getElementById('btn-save-event')?.addEventListener('click', saveEvent);
    document.getElementById('btn-cancel-event')?.addEventListener('click', () => {
      document.getElementById('event-add-modal')?.classList.remove('active');
    });

    // Googleカレンダーからインポートボタン
    document.getElementById('btn-sync-from-google')?.addEventListener('click', syncFromGoogle);
  }

  // ── AI向け公開API（google-services.jsから呼ばれる） ──
  function aiAddEvent(eventData) {
    const ev = {
      emoji: eventData.emoji || '📅',
      title: eventData.title,
      startDate: eventData.startDate,
      endDate: eventData.endDate || '',
      startTime: eventData.startTime || '',
      endTime: eventData.endTime || '',
      isAllDay: !!eventData.isAllDay,
      description: eventData.description || '',
      createdBy: 'ai',
    };
    MindLinkStorage.saveCalendarEvent(ev);
    // カレンダーが開いていれば再描画
    if (document.getElementById('calendar-modal')?.classList.contains('active')) {
      renderCalendar();
      if (_selectedDate) renderDayView(_selectedDate);
    }
    return ev;
  }

  function aiListEvents(dateStr) {
    if (dateStr) {
      return MindLinkStorage.getCalendarEventsForDate(dateStr);
    }
    return MindLinkStorage.getCalendarEvents();
  }

  function aiDeleteEvent(id) {
    const events = MindLinkStorage.getCalendarEvents();
    const ev = events.find(e => e.id === id);
    if (!ev) return false;
    MindLinkStorage.deleteCalendarEvent(id);
    if (document.getElementById('calendar-modal')?.classList.contains('active')) {
      renderCalendar();
      if (_selectedDate) renderDayView(_selectedDate);
    }
    return true;
  }

  function aiUpdateEvent(id, partial) {
    const result = MindLinkStorage.updateCalendarEvent(id, partial);
    if (result && document.getElementById('calendar-modal')?.classList.contains('active')) {
      renderCalendar();
      if (_selectedDate) renderDayView(_selectedDate);
    }
    return result;
  }

  // DOMContentLoaded で初期化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    openCalendarModal,
    renderCalendar,
    renderDayView,
    aiAddEvent,
    aiListEvents,
    aiDeleteEvent,
    aiUpdateEvent,
  };
})();

window.MindLinkCalendar = MindLinkCalendar;
