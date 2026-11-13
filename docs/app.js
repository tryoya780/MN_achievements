(() => {
  'use strict';

  const tg = window.Telegram?.WebApp;
  const API = (window.APP_CONFIG?.API_URL || '').replace(/\/+$/, '');
  const $app = document.getElementById('app');
  const $overlay = document.getElementById('overlay');
  const $file = document.getElementById('file-input');

  const RARITY = {
    common:    { name: 'Обычная',     xp: 10 },
    rare:      { name: 'Редкая',      xp: 25 },
    epic:      { name: 'Эпическая',   xp: 50 },
    legendary: { name: 'Легендарная', xp: 100 },
  };
  const LEVEL_TITLES = ['Знакомство', 'Симпатия', 'Свидания', 'Влюблённые', 'Пара', 'Команда', 'Родные души', 'Легенда'];
  const EMOJIS = ['❤️', '💋', '🌹', '💍', '🏠', '✈️', '🎉', '🎂', '🍝', '☕', '🎬', '🌊', '🏔️', '🐶', '🐱', '🎁', '🔥', '⭐', '🌙', '🎵', '📸', '🚗', '🥂', '🤝'];

  const state = {
    user: null,
    settings: {},
    items: [],
    filter: 'unlocked',
    stack: [{ name: 'home' }],
    draft: null,
    pendingPhoto: null, // { blob, url } — обрезанное, ещё не загруженное фото
    busy: false,
  };

  // ---------- API ----------

  function authHeader() {
    if (tg?.initData) return 'tma ' + tg.initData;
    if (['localhost', '127.0.0.1'].includes(location.hostname)) return 'dev';
    return '';
  }

  async function api(path, { method = 'GET', body, raw, contentType } = {}) {
    const headers = { Authorization: authHeader() };
    let payload;
    if (raw) { payload = raw; headers['Content-Type'] = contentType; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(API + path, { method, headers, body: payload });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Ошибка сети');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const photoCache = new Map(); // photo_id -> Promise<objectURL>
  function photoUrl(id) {
    if (!photoCache.has(id)) {
      const p = fetch(`${API}/api/photos/${id}`, { headers: { Authorization: authHeader() } })
        .then((r) => { if (!r.ok) throw new Error('photo'); return r.blob(); })
        .then((b) => URL.createObjectURL(b));
      p.catch(() => photoCache.delete(id));
      photoCache.set(id, p);
    }
    return photoCache.get(id);
  }

  function hydratePhotos(root = document) {
    root.querySelectorAll('img[data-photo]').forEach((img) => {
      const id = img.dataset.photo;
      img.removeAttribute('data-photo');
      photoUrl(id).then((url) => {
        img.onload = () => img.classList.add('loaded');
        img.src = url;
      }).catch(() => {});
    });
  }

  // ---------- утилиты ----------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function parseIso(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function daysBetween(a, b) {
    return Math.round((b - a) / 86400000);
  }
  function fmtDate(s) {
    if (!s) return '';
    return parseIso(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function fmtShortDate(s) {
    if (!s) return '';
    return parseIso(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: '2-digit' }).replace(' г.', '');
  }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }
  function relative(s) {
    const days = daysBetween(parseIso(s), parseIso(todayIso()));
    if (days === 0) return 'сегодня';
    if (days < 0) return 'в будущем';
    if (days < 31) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
    const months = Math.floor(days / 30.44);
    if (months < 12) return `${months} ${plural(months, 'месяц', 'месяца', 'месяцев')} назад`;
    const years = Math.floor(days / 365.25);
    return `${years} ${plural(years, 'год', 'года', 'лет')} назад`;
  }

  function levelInfo(xp) {
    let level = 1, need = 100, rest = xp;
    while (rest >= need) { rest -= need; level++; need = Math.round(need * 1.25); }
    return { level, current: rest, need, title: LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)] };
  }

  function haptic(type = 'light') {
    try {
      if (type === 'success' || type === 'error') tg?.HapticFeedback?.notificationOccurred(type);
      else tg?.HapticFeedback?.impactOccurred(type);
    } catch {}
  }

  let toastTimer;
  function toast(text) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function confirmDialog(text) {
    return new Promise((resolve) => {
      if (tg?.showConfirm && tg.initData) tg.showConfirm(text, resolve);
      else resolve(window.confirm(text));
    });
  }

  function medal(item, { big = false, photoOverride } = {}) {
    const locked = item.status === 'locked';
    const cls = `medal r-${item.rarity}${big ? ' big' : ''}`;
    let inner;
    if (photoOverride) inner = `<img class="loaded" src="${photoOverride}" alt="">`;
    else if (item.photo_id) inner = `<img data-photo="${esc(item.photo_id)}" alt="">`;
    else inner = esc(item.icon || '❤️');
    return `<div class="${cls}"><div class="medal-inner">${inner}</div>${locked ? '<span class="lock">🔒</span>' : ''}</div>`;
  }

  // ---------- навигация ----------

  const current = () => state.stack[state.stack.length - 1];

  function go(name, params = {}) {
    current().scroll = window.scrollY;
    state.stack.push({ name, ...params });
    render();
    window.scrollTo(0, 0);
  }

  function back() {
    if (state.stack.length <= 1) return;
    const leaving = state.stack.pop();
    if (leaving.name === 'editor') clearDraft();
    render();
    window.scrollTo(0, current().scroll || 0);
  }

  function resetTo(name, params = {}) {
    clearDraft();
    state.stack = [{ name: 'home' }];
    if (name !== 'home') state.stack.push({ name, ...params });
    render();
    window.scrollTo(0, 0);
  }

  function clearDraft() {
    state.draft = null;
    if (state.pendingPhoto) URL.revokeObjectURL(state.pendingPhoto.url);
    state.pendingPhoto = null;
  }

  function syncBackButton() {
    if (!tg?.BackButton) return;
    if (state.stack.length > 1) tg.BackButton.show(); else tg.BackButton.hide();
  }

  // ---------- экраны ----------

  let lastScreen = null;
  function render() {
    const screen = current();
    const view = { home: renderHome, detail: renderDetail, editor: renderEditor, settings: renderSettings }[screen.name];
    $app.innerHTML = view(screen);
    if (screen !== lastScreen) $app.querySelector('.page')?.classList.add('enter');
    lastScreen = screen;
    hydratePhotos($app);
    syncBackButton();
  }

  function renderHome() {
    const unlocked = state.items.filter((i) => i.status === 'unlocked');
    const locked = state.items.filter((i) => i.status === 'locked');
    const legendary = unlocked.filter((i) => i.rarity === 'legendary').length;
    const xp = unlocked.reduce((s, i) => s + (RARITY[i.rarity]?.xp || 0), 0);
    const lv = levelInfo(xp);
    const s = state.settings;

    let together = 'Укажите дату начала в настройках';
    if (s.start_date) {
      const d = daysBetween(parseIso(s.start_date), parseIso(todayIso()));
      together = d >= 0 ? `Вместе ${d} ${plural(d, 'день', 'дня', 'дней')}` : 'Скоро начало истории';
    }

    const list = state.filter === 'unlocked' ? unlocked : state.filter === 'locked' ? locked : state.items;
    const tiles = list.map((i) => `
      <button class="tile r-${i.rarity}${i.status === 'locked' ? ' locked' : ''}" data-action="open" data-id="${i.id}">
        ${medal(i)}
        <div class="tile-title">${esc(i.title)}</div>
        ${i.date ? `<div class="tile-date">${fmtShortDate(i.date)}</div>` : ''}
      </button>`).join('');

    const emptyText = {
      unlocked: ['🏆', 'Пока ни одной ачивки.<br>Добавьте первое важное событие!'],
      locked: ['🎯', 'Целей пока нет.<br>Добавьте мечту — она будет ждать разблокировки.'],
      all: ['✨', 'Здесь будут все ваши ачивки и цели.'],
    }[state.filter];

    return `
      <div class="page">
        <div class="topbar">
          <h1>${esc(s.couple_name || 'Наши ачивки')}</h1>
          <button class="icon-btn" data-action="settings" aria-label="Настройки">⚙️</button>
        </div>

        <div class="hero">
          <div class="hero-row">
            <div class="level-badge"><div><small>LVL</small><b>${lv.level}</b></div></div>
            <div>
              <div class="hero-title">${esc(lv.title)}</div>
              <div class="hero-sub">${esc(together)}</div>
            </div>
          </div>
          <div class="xp">
            <div class="xp-bar"><div class="xp-fill" style="width:${Math.round((lv.current / lv.need) * 100)}%"></div></div>
            <div class="xp-meta"><span>${lv.current} / ${lv.need} XP</span><span>всего ${xp} XP</span></div>
          </div>
        </div>

        <div class="stats">
          <div class="stat"><b>${unlocked.length}</b><span>открыто</span></div>
          <div class="stat"><b>${locked.length}</b><span>${plural(locked.length, 'цель', 'цели', 'целей')}</span></div>
          <div class="stat"><b>${legendary}</b><span>легендарных</span></div>
        </div>

        ${renderAnniversaryBanner(unlocked)}

        <div class="segmented">
          <button data-action="filter" data-filter="unlocked" class="${state.filter === 'unlocked' ? 'active' : ''}">Открытые</button>
          <button data-action="filter" data-filter="locked" class="${state.filter === 'locked' ? 'active' : ''}">Цели</button>
          <button data-action="filter" data-filter="all" class="${state.filter === 'all' ? 'active' : ''}">Все</button>
        </div>

        ${list.length ? `<div class="grid">${tiles}</div>` : `<div class="empty"><div class="big">${emptyText[0]}</div>${emptyText[1]}</div>`}
      </div>
      <button class="fab" data-action="new">＋ Новая ачивка</button>`;
  }

  function renderAnniversaryBanner(unlocked) {
    const today = parseIso(todayIso());
    let best = null;
    const candidates = unlocked.map((i) => ({ item: i, date: i.date }));
    if (state.settings.start_date) candidates.push({ item: null, date: state.settings.start_date });
    for (const c of candidates) {
      if (!c.date) continue;
      const d = parseIso(c.date);
      let next = new Date(today.getFullYear(), d.getMonth(), d.getDate());
      if (next < today) next = new Date(today.getFullYear() + 1, d.getMonth(), d.getDate());
      const years = next.getFullYear() - d.getFullYear();
      if (years < 1) continue;
      const inDays = daysBetween(today, next);
      if (inDays <= 30 && (!best || inDays < best.inDays)) best = { ...c, inDays, years };
    }
    if (!best) return '';
    const what = best.item ? `«${esc(best.item.title)}»` : 'начала отношений';
    const when = best.inDays === 0 ? 'Сегодня' : `Через ${best.inDays} ${plural(best.inDays, 'день', 'дня', 'дней')}`;
    const attrs = best.item ? `data-action="open" data-id="${best.item.id}"` : 'data-action="settings"';
    return `<button class="banner" ${attrs}><span class="emoji">🎂</span><span><b>${when}</b> — ${best.years} ${plural(best.years, 'год', 'года', 'лет')} с ${what}</span></button>`;
  }

  function renderDetail({ id }) {
    const item = state.items.find((i) => i.id === id);
    if (!item) return `<div class="center-screen"><div><div class="muted">Ачивка не найдена</div></div></div>`;
    const locked = item.status === 'locked';
    const rarity = RARITY[item.rarity];
    return `
      <div class="page detail">
        ${medal(item, { big: true })}
        <span class="rarity-chip ${locked ? 'locked' : item.rarity}">${locked ? 'Цель · ' : ''}${rarity.name}</span>
        <h2>${esc(item.title)}</h2>
        <div class="date">${locked ? 'Ещё не получена' : `${fmtDate(item.date)} · ${relative(item.date)}`}</div>
        ${item.description ? `<div class="desc">${esc(item.description)}</div>` : '<div style="height:12px"></div>'}
        <div class="meta-row">
          <span>${locked ? 'Награда' : 'Получено'}: +${rarity.xp} XP</span>
          ${item.created_by_name ? `<span>Добавил(а): ${esc(item.created_by_name)}</span>` : ''}
        </div>
        <div class="actions">
          ${locked ? `<button class="btn primary" data-action="unlock" data-id="${item.id}">🔓 Разблокировать</button>` : ''}
          <button class="btn" data-action="edit" data-id="${item.id}">✏️ Редактировать</button>
          <button class="btn danger" data-action="delete" data-id="${item.id}">Удалить</button>
        </div>
      </div>`;
  }

  function renderEditor({ mode }) {
    const d = state.draft;
    const isLocked = d.status === 'locked';
    const titleText = mode === 'create' ? (isLocked ? 'Новая цель' : 'Новая ачивка') : mode === 'unlock' ? 'Разблокировать' : 'Редактирование';
    const preview = { ...d, photo_id: state.pendingPhoto ? null : d.photo_id };
    const hasPhoto = !!(state.pendingPhoto || d.photo_id);

    return `
      <div class="page">
        <div class="topbar"><h1>${titleText}</h1></div>

        ${mode !== 'unlock' ? `
        <div class="segmented" style="margin-top:0">
          <button data-action="set-status" data-value="unlocked" class="${!isLocked ? 'active' : ''}">🏆 Ачивка</button>
          <button data-action="set-status" data-value="locked" class="${isLocked ? 'active' : ''}">🎯 Цель (закрыта)</button>
        </div>` : ''}

        <div class="form-photo">
          <div data-action="pick-photo">${medal(preview, { big: true, photoOverride: state.pendingPhoto?.url })}</div>
          <div class="photo-links">
            <button data-action="pick-photo">${hasPhoto ? 'Сменить фото' : '📷 Добавить фото'}</button>
            ${hasPhoto ? '<button class="danger" data-action="remove-photo">Убрать</button>' : ''}
          </div>
        </div>

        ${!hasPhoto ? `
        <div class="section-title">Иконка вместо фото</div>
        <div class="section"><div class="emoji-row">
          ${EMOJIS.map((e) => `<button data-action="set-icon" data-value="${e}" class="${d.icon === e ? 'active' : ''}">${e}</button>`).join('')}
        </div></div>` : ''}

        <div class="section">
          <div class="field">
            <label>Название</label>
            <input data-field="title" maxlength="80" placeholder="Например: Первое свидание" value="${esc(d.title)}">
          </div>
          <div class="field">
            <label>Описание</label>
            <textarea data-field="description" maxlength="1000" placeholder="Как это было, что запомнилось…">${esc(d.description)}</textarea>
          </div>
          ${!isLocked ? `
          <div class="field">
            <label>Дата</label>
            <input type="date" data-field="date" value="${esc(d.date || todayIso())}" max="2100-12-31">
          </div>` : ''}
        </div>

        <div class="section-title">Редкость</div>
        <div class="rarity-grid">
          ${Object.entries(RARITY).map(([key, r]) => `
            <button class="rarity-opt ${key}${d.rarity === key ? ' active' : ''}" data-action="set-rarity" data-value="${key}">
              <span class="dot"></span><span><b>${r.name}</b><small>+${r.xp} XP</small></span>
            </button>`).join('')}
        </div>
        ${isLocked ? '<p class="hint-text">Цель видна как закрытая ачивка. Когда она сбудется — нажмите «Разблокировать».</p>' : ''}
      </div>
      <div class="bottom-bar">
        <button class="btn primary" data-action="save" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Сохраняю…' : mode === 'unlock' ? '🔓 Разблокировать' : 'Сохранить'}</button>
      </div>`;
  }

  function renderSettings() {
    const s = state.settings;
    return `
      <div class="page">
        <div class="topbar"><h1>Настройки</h1></div>
        <div class="section">
          <div class="field">
            <label>Название пары</label>
            <input data-setting="couple_name" maxlength="60" placeholder="Например: Мотя & Аня" value="${esc(s.couple_name || '')}">
          </div>
          <div class="field">
            <label>Дата начала отношений</label>
            <input type="date" data-setting="start_date" value="${esc(s.start_date || '')}">
          </div>
        </div>
        <p class="hint-text">Настройки общие для вас двоих.</p>
        <div class="section-title">Как считается уровень</div>
        <div class="section" style="padding:12px 14px;font-size:14px">
          ${Object.values(RARITY).map((r) => `${r.name} — +${r.xp} XP`).join('<br>')}
          <div class="muted" style="margin-top:8px;font-size:12px">Цели (закрытые ачивки) дают XP только после разблокировки.</div>
        </div>
        <p class="hint-text">Ваш Telegram ID: ${esc(state.user?.id)}</p>
      </div>
      <div class="bottom-bar"><button class="btn primary" data-action="save-settings" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Сохраняю…' : 'Сохранить'}</button></div>`;
  }

  function renderError(err) {
    if (err.status === 403 && err.data?.user_id) {
      $app.innerHTML = `
        <div class="center-screen"><div>
          <div style="font-size:52px">🔒</div>
          <h2>Это приватное приложение</h2>
          <p class="muted">Чтобы получить доступ, ваш ID нужно добавить в настройки сервера:</p>
          <div class="code">${esc(err.data.user_id)}</div>
        </div></div>`;
      return;
    }
    $app.innerHTML = `
      <div class="center-screen"><div>
        <div style="font-size:52px">😿</div>
        <h2>Не получилось загрузить</h2>
        <p class="muted">${esc(err.message)}</p>
        <button class="btn primary" data-action="reload" style="margin-top:12px">Повторить</button>
      </div></div>`;
  }

  // ---------- празднование ----------

  function celebrate(item) {
    haptic('success');
    const colors = ['#ff4f7b', '#ff8a5c', '#fde68a', '#a855f7', '#3b82f6', '#34d399'];
    const confetti = Array.from({ length: 70 }, () => {
      const left = Math.random() * 100;
      const dur = 2.2 + Math.random() * 2.2;
      const delay = Math.random() * 0.8;
      const c = colors[Math.floor(Math.random() * colors.length)];
      return `<span class="confetti" style="left:${left}%;background:${c};animation-duration:${dur}s;animation-delay:${delay}s;transform:rotate(${Math.random() * 360}deg)"></span>`;
    }).join('');
    $overlay.innerHTML = `
      <div class="celebrate" data-action="close-overlay">
        <div class="rays"></div>${confetti}
        <div class="content">
          <div class="label">Достижение получено</div>
          ${medal(item, { big: true })}
          <h2>${esc(item.title)}</h2>
          <div class="xp-gain">+${RARITY[item.rarity].xp} XP · ${RARITY[item.rarity].name}</div>
          <div class="tap">нажмите, чтобы продолжить</div>
        </div>
      </div>`;
    hydratePhotos($overlay);
  }

  // ---------- обрезка фото в круг ----------

  function openCropper(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => startCrop(img, url);
    img.onerror = () => { URL.revokeObjectURL(url); toast('Не удалось открыть картинку'); };
    img.src = url;
  }

  function startCrop(img, url) {
    const V = Math.min(320, window.innerWidth - 40);
    const minScale = Math.max(V / img.naturalWidth, V / img.naturalHeight);
    const c = { scale: minScale, x: 0, y: 0 };
    c.x = (V - img.naturalWidth * c.scale) / 2;
    c.y = (V - img.naturalHeight * c.scale) / 2;

    $overlay.innerHTML = `
      <div class="cropper">
        <div class="crop-title">Подвиньте и приблизьте фото</div>
        <div class="crop-view" style="width:${V}px;height:${V}px"><div class="crop-mask"></div></div>
        <input class="crop-zoom" type="range" min="1" max="4" step="0.01" value="1">
        <div class="crop-actions">
          <button class="btn" data-crop="cancel">Отмена</button>
          <button class="btn primary" data-crop="ok">Готово</button>
        </div>
      </div>`;
    const view = $overlay.querySelector('.crop-view');
    const zoom = $overlay.querySelector('.crop-zoom');
    view.prepend(img);

    const clamp = () => {
      const w = img.naturalWidth * c.scale, h = img.naturalHeight * c.scale;
      c.x = Math.min(0, Math.max(V - w, c.x));
      c.y = Math.min(0, Math.max(V - h, c.y));
    };
    const apply = () => { clamp(); img.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.scale})`; };
    const zoomTo = (newScale, cx = V / 2, cy = V / 2) => {
      newScale = Math.max(minScale, Math.min(minScale * 4, newScale));
      c.x = cx - ((cx - c.x) * newScale) / c.scale;
      c.y = cy - ((cy - c.y) * newScale) / c.scale;
      c.scale = newScale;
      zoom.value = String(newScale / minScale);
      apply();
    };
    apply();

    zoom.addEventListener('input', () => zoomTo(minScale * Number(zoom.value)));
    view.addEventListener('wheel', (e) => { e.preventDefault(); zoomTo(c.scale * (e.deltaY < 0 ? 1.08 : 0.92)); }, { passive: false });

    const pointers = new Map();
    let last = null;
    view.addEventListener('pointerdown', (e) => {
      view.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      last = null;
    });
    view.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...pointers.values()];
      const rect = view.getBoundingClientRect();
      if (pts.length === 1) {
        if (last?.type === 'drag') { c.x += pts[0].x - last.x; c.y += pts[0].y - last.y; apply(); }
        last = { type: 'drag', x: pts[0].x, y: pts[0].y };
      } else if (pts.length >= 2) {
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const mx = (pts[0].x + pts[1].x) / 2 - rect.left, my = (pts[0].y + pts[1].y) / 2 - rect.top;
        if (last?.type === 'pinch') {
          c.x += mx - last.mx; c.y += my - last.my;
          zoomTo(c.scale * (dist / last.dist), mx, my);
        }
        last = { type: 'pinch', dist, mx, my };
      }
    });
    const up = (e) => { pointers.delete(e.pointerId); last = null; };
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);

    $overlay.querySelector('[data-crop="cancel"]').onclick = () => { $overlay.innerHTML = ''; URL.revokeObjectURL(url); };
    $overlay.querySelector('[data-crop="ok"]').onclick = () => {
      const OUT = 900;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = OUT;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      const size = V / c.scale;
      ctx.drawImage(img, -c.x / c.scale, -c.y / c.scale, size, size, 0, 0, OUT, OUT);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        $overlay.innerHTML = '';
        if (!blob) return toast('Не удалось обработать фото');
        if (state.pendingPhoto) URL.revokeObjectURL(state.pendingPhoto.url);
        state.pendingPhoto = { blob, url: URL.createObjectURL(blob) };
        haptic('light');
        render();
      }, 'image/jpeg', 0.86);
    };
  }

  // ---------- действия ----------

  function openEditor(mode, item) {
    clearDraft();
    if (item) {
      state.draft = { ...item };
      if (mode === 'unlock') { state.draft.status = 'unlocked'; state.draft.date = todayIso(); }
    } else {
      state.draft = {
        title: '', description: '', date: todayIso(), rarity: 'common',
        status: state.filter === 'locked' ? 'locked' : 'unlocked', icon: '❤️', photo_id: null,
      };
    }
    go('editor', { mode, id: item?.id });
  }

  async function saveDraft() {
    const screen = current();
    const d = state.draft;
    if (!d.title.trim()) { haptic('error'); toast('Введите название'); return; }
    if (d.status === 'unlocked' && !d.date) d.date = todayIso();

    state.busy = true; render();
    try {
      let photoId = d.photo_id || null;
      if (state.pendingPhoto) {
        const up = await api('/api/photos', { method: 'POST', raw: state.pendingPhoto.blob, contentType: 'image/jpeg' });
        photoId = up.photo_id;
        d.photo_id = photoId;
        photoCache.set(photoId, Promise.resolve(state.pendingPhoto.url));
        state.pendingPhoto = null; // url теперь живёт в кэше
      }
      const body = {
        title: d.title.trim(), description: (d.description || '').trim(), rarity: d.rarity,
        status: d.status, icon: d.icon, photo_id: photoId, date: d.status === 'locked' ? null : d.date,
      };
      let saved;
      if (screen.mode === 'create') {
        saved = (await api('/api/achievements', { method: 'POST', body })).achievement;
        state.items.unshift(saved);
      } else {
        saved = (await api(`/api/achievements/${screen.id}`, { method: 'PATCH', body })).achievement;
        state.items = state.items.map((i) => (i.id === saved.id ? saved : i));
      }
      sortItems();
      state.busy = false;
      const wasUnlocked = screen.mode === 'unlock' || (screen.mode === 'create' && saved.status === 'unlocked');
      state.filter = saved.status === 'locked' ? 'locked' : (state.filter === 'all' ? 'all' : 'unlocked');
      resetTo('detail', { id: saved.id });
      if (wasUnlocked) celebrate(saved); else { haptic('success'); toast('Сохранено'); }
    } catch (err) {
      state.busy = false; render();
      haptic('error'); toast(err.message);
    }
  }

  function sortItems() {
    state.items.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'unlocked' ? -1 : 1;
      if ((a.date || '') !== (b.date || '')) return (b.date || '').localeCompare(a.date || '');
      return b.created_at.localeCompare(a.created_at);
    });
  }

  async function deleteItem(id) {
    const item = state.items.find((i) => i.id === id);
    if (!item || !(await confirmDialog(`Удалить «${item.title}»? Это нельзя отменить.`))) return;
    try {
      await api(`/api/achievements/${id}`, { method: 'DELETE' });
      state.items = state.items.filter((i) => i.id !== id);
      haptic('success'); toast('Удалено');
      resetTo('home');
    } catch (err) { haptic('error'); toast(err.message); }
  }

  async function saveSettings() {
    const body = {};
    $app.querySelectorAll('[data-setting]').forEach((el) => { body[el.dataset.setting] = el.value; });
    state.busy = true; render();
    try {
      state.settings = (await api('/api/settings', { method: 'PUT', body })).settings;
      state.busy = false; haptic('success'); toast('Сохранено');
      resetTo('home');
    } catch (err) {
      state.busy = false; render(); haptic('error'); toast(err.message);
    }
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id, value } = el.dataset;
    switch (action) {
      case 'open': haptic('light'); go('detail', { id }); break;
      case 'filter': state.filter = el.dataset.filter; haptic('light'); render(); break;
      case 'new': haptic('light'); openEditor('create'); break;
      case 'edit': openEditor('edit', state.items.find((i) => i.id === id)); break;
      case 'unlock': openEditor('unlock', state.items.find((i) => i.id === id)); break;
      case 'delete': deleteItem(id); break;
      case 'settings': go('settings'); break;
      case 'save': if (!state.busy) saveDraft(); break;
      case 'save-settings': if (!state.busy) saveSettings(); break;
      case 'set-status': state.draft.status = value; if (value === 'unlocked' && !state.draft.date) state.draft.date = todayIso(); haptic('light'); render(); break;
      case 'set-rarity': state.draft.rarity = value; haptic('light'); render(); break;
      case 'set-icon': state.draft.icon = value; haptic('light'); render(); break;
      case 'pick-photo': $file.value = ''; $file.click(); break;
      case 'remove-photo':
        if (state.pendingPhoto) { URL.revokeObjectURL(state.pendingPhoto.url); state.pendingPhoto = null; }
        state.draft.photo_id = null; render(); break;
      case 'close-overlay': $overlay.innerHTML = ''; break;
      case 'reload': boot(); break;
    }
  });

  document.addEventListener('input', (e) => {
    const f = e.target.dataset?.field;
    if (f && state.draft) state.draft[f] = e.target.value;
  });

  $file.addEventListener('change', () => {
    const file = $file.files?.[0];
    if (file) openCropper(file);
  });

  // ---------- старт ----------

  async function boot() {
    $app.innerHTML = '<div class="center-screen"><div class="spinner"></div></div>';
    try {
      if (!API || API.includes('YOUR-SUBDOMAIN')) throw new Error('Не указан адрес API в config.js');
      const [me, list] = await Promise.all([api('/api/me'), api('/api/achievements')]);
      state.user = me.user;
      state.settings = me.settings || {};
      state.items = list.achievements || [];
      sortItems();
      render();
    } catch (err) {
      renderError(err);
    }
  }

  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.disableVerticalSwipes?.(); } catch {}
    try {
      tg.setBackgroundColor?.('secondary_bg_color');
      tg.setHeaderColor?.('secondary_bg_color');
    } catch {}
    tg.BackButton?.onClick(() => {
      if ($overlay.innerHTML) { $overlay.innerHTML = ''; return; }
      back();
    });
  }

  boot();
})();
