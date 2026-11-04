import { config } from './config.js';
import { createStore, TakenError, OfflineError } from './store.js';

/* ---------- Утилиты ---------- */

const $ = (sel) => document.querySelector(sel);

// Всё, что ввели люди, попадает на страницу только как текст, поэтому чужой HTML не выполнится.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid);
  }
  return el;
}

const money = (n) => `${Number(n).toLocaleString('ru-RU')} ₽`;

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const safeUrl = (url) => (/^https?:\/\//i.test(url || '') ? url : null);

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const NAME_KEY = 'wishlist-name';
function savedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}
function rememberName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* приватный режим */ }
}

let toastTimer;
function toast(text, isError = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('is-error', isError);
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 3600);
}

function explain(err) {
  if (err instanceof TakenError) return 'Кто-то успел раньше: подарок уже заняли.';
  if (err instanceof OfflineError) return 'Нет связи с сервером. Проверь интернет и попробуй ещё раз.';
  console.error(err);
  return 'Не получилось сохранить. Попробуй ещё раз.';
}

function confetti() {
  if (reducedMotion()) return;
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.display = 'block';
  ctx.scale(dpr, dpr);
  const colors = ['#FF4A1C', '#C8F135', '#141210', '#FFFDF8'];
  const bits = Array.from({ length: 90 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 120,
    y: innerHeight * 0.55,
    vx: (Math.random() - 0.5) * 15,
    vy: -7 - Math.random() * 13,
    w: 6 + Math.random() * 8,
    h: 8 + Math.random() * 12,
    r: Math.random() * 6,
    vr: (Math.random() - 0.5) * 0.4,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.vy += 0.34;
      b.x += b.vx;
      b.y += b.vy;
      b.r += b.vr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.r);
      ctx.globalAlpha = Math.max(0, 1 - t / 1700);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (t < 1700) requestAnimationFrame(frame);
    else canvas.style.display = 'none';
  })(start);
}

/* ---------- Окно ---------- */

const sheet = $('#sheet');
const sheetBody = $('#sheetBody');

function openSheet(...content) {
  sheetBody.replaceChildren(...content);
  if (!sheet.open) sheet.showModal();
}
const closeSheet = () => sheet.close();

$('#sheetClose').addEventListener('click', closeSheet);
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input,
    hint ? h('span', { class: 'field-hint' }, hint) : null);
}

function form(onSubmit, submitLabel, ...fields) {
  const error = h('p', { class: 'form-error', role: 'alert' });
  const button = h('button', { type: 'submit', class: 'btn btn-ink btn-wide' }, submitLabel);
  const el = h('form', {
    class: 'form',
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      button.disabled = true;
      try {
        await onSubmit();
      } catch (err) {
        error.textContent = err.userMessage || explain(err);
      } finally {
        button.disabled = false;
      }
    },
  }, ...fields, error, button);
  return el;
}

function askConfirm(title, text, actionLabel, action) {
  openSheet(
    h('h3', { class: 'sheet-title' }, title),
    h('p', { class: 'sheet-text' }, text),
    h('div', { class: 'sheet-actions' },
      h('button', {
        type: 'button',
        class: 'btn btn-red',
        onclick: async () => {
          closeSheet();
          try { await action(); } catch (err) { toast(explain(err), true); }
        },
      }, actionLabel),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeSheet }, 'Отмена')),
  );
}

/* ---------- Состояние ---------- */

let store;
let state = { gifts: [], claims: [], settings: {}, ready: false };
let filter = 'all';
const settings = () => ({ ...config.defaults, ...state.settings });
const sortedGifts = () => [...state.gifts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const claimsOf = (giftId) => state.claims
  .filter((c) => c.giftId === giftId)
  .sort((a, b) => a.createdAt - b.createdAt);

function statusOf(giftId) {
  const claims = claimsOf(giftId);
  const book = claims.find((c) => c.type === 'book');
  const chips = claims.filter((c) => c.type === 'chip');
  if (book) return { kind: 'booked', book, chips };
  if (chips.length) return { kind: 'chip', chips };
  return { kind: 'free', chips };
}

/* ---------- Шапка ---------- */

function nextBirthday(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let date = new Date(today.getFullYear(), +m[2] - 1, +m[3]);
  if (date < today) date = new Date(today.getFullYear() + 1, +m[2] - 1, +m[3]);
  return { date, days: Math.round((date - today) / 86400000) };
}

function fitHeroTitle() {
  const title = $('#heroTitle');
  title.style.fontSize = '';
  const words = [...title.children];
  const available = title.clientWidth;
  const widest = Math.max(...words.map((w) => w.getBoundingClientRect().width), 1);
  if (widest > available) {
    const current = parseFloat(getComputedStyle(title).fontSize);
    title.style.fontSize = `${Math.floor((current * available) / widest)}px`;
  }
}

function renderHero() {
  const s = settings();
  const words = String(s.title || 'Вишлист').trim().split(/\s+/);
  $('#heroTitle').replaceChildren(...words.map((w) => h('span', {}, w)));
  $('#heroText').textContent = s.text || '';
  document.title = s.title || 'Вишлист';

  const next = nextBirthday(s.date);
  $('#heroDate').textContent = next
    ? next.date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
    : '';
  if (!next) {
    $('#stickerNum').textContent = '★';
    $('#stickerLabel').textContent = '';
  } else if (next.days === 0) {
    $('#stickerNum').textContent = '★';
    $('#stickerLabel').textContent = 'сегодня';
  } else {
    $('#stickerNum').textContent = next.days;
    $('#stickerLabel').textContent = plural(next.days, 'день', 'дня', 'дней');
  }
  fitHeroTitle();
}

/* ---------- Карточки ---------- */

const cardCache = new Map();
const revealer = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('is-in');
        revealer.unobserve(e.target);
      }
    }
  }, { rootMargin: '0px 0px -6% 0px' })
  : null;

function personRow(claim) {
  const mine = claim.uid === store.me();
  return h('li', { class: 'person' },
    h('span', { class: 'person-mark', 'aria-hidden': 'true' }, claim.name.trim().charAt(0).toUpperCase()),
    h('span', { class: 'person-name' }, claim.name, mine ? h('em', {}, ' это ты') : null),
    claim.amount ? h('span', { class: 'person-amount' }, money(claim.amount)) : null);
}

function buildCard(gift, index) {
  const st = statusOf(gift.id);
  const mine = (c) => c && c.uid === store.me();
  const myChip = st.chips.find(mine);
  const url = safeUrl(gift.url);
  const number = String(index + 1).padStart(2, '0');

  const photo = gift.photo
    ? h('img', { src: gift.photo, alt: gift.title, loading: 'lazy', decoding: 'async' })
    : h('div', { class: `photo-empty tone-${index % 3}`, 'aria-hidden': 'true' }, number);

  const media = h('div', { class: 'card-media' },
    photo,
    gift.photo ? h('span', { class: 'card-num' }, number) : null,
    st.kind === 'booked'
      ? h('div', { class: 'stamp' }, h('small', {}, 'Дарит'), h('b', {}, st.book.name))
      : null);

  const body = h('div', { class: 'card-body' },
    h('h3', { class: 'card-title' }, gift.title),
    gift.price ? h('p', { class: 'card-price' }, money(gift.price)) : null,
    gift.note ? h('p', { class: 'card-note' }, gift.note) : null,
    url ? h('a', { class: 'card-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Где купить ↗') : null);

  if (st.kind === 'chip') {
    const sum = st.chips.reduce((acc, c) => acc + (c.amount || 0), 0);
    const pct = gift.price ? Math.min(100, Math.round((sum / gift.price) * 100)) : 0;
    const count = st.chips.length;
    const box = h('div', { class: 'chipbox' },
      h('p', { class: 'chipbox-head' },
        `${count} ${plural(count, 'человек скидывается', 'человека скидываются', 'человек скидываются')}`),
      gift.price && sum > 0
        ? h('div', {},
          h('div', {
            class: 'bar',
            role: 'progressbar',
            'aria-valuenow': pct,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-label': 'Собрано',
          }, h('i', { style: `width:${pct}%` })),
          h('p', { class: 'bar-text' }, `Собрано ${money(sum)} из ${money(gift.price)}`))
        : null,
      h('ul', { class: 'people' }, st.chips.map(personRow)));
    body.append(box);
  }

  if (st.kind === 'booked' && st.book.note) {
    body.append(h('p', { class: 'card-claimnote' }, `«${st.book.note}»`));
  }

  const actions = h('div', { class: 'card-actions' });
  if (st.kind === 'free') {
    actions.append(
      h('button', { type: 'button', class: 'btn btn-ink', onclick: () => openClaim('book', gift) }, 'Забронировать'),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => openClaim('chip', gift) }, 'Скинуться'),
    );
  } else if (st.kind === 'chip') {
    if (myChip) {
      actions.append(
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => openClaim('chip', gift, myChip) }, 'Изменить'),
        h('button', { type: 'button', class: 'btn-text', onclick: () => cancelClaim(myChip, 'Выйти из складчины?') }, 'Выйти из складчины'),
      );
    } else {
      actions.append(h('button', { type: 'button', class: 'btn btn-lime', onclick: () => openClaim('chip', gift) }, 'Скинуться тоже'));
    }
  } else if (mine(st.book)) {
    actions.append(h('button', {
      type: 'button',
      class: 'btn btn-ghost',
      onclick: () => cancelClaim(st.book, 'Снять бронь?'),
    }, 'Снять бронь'));
  } else {
    actions.append(h('p', { class: 'card-taken' }, 'Этот подарок уже занят'));
  }
  body.append(actions);

  return h('article', { class: `card is-${st.kind}` }, media, body);
}

function cancelClaim(claim, title) {
  askConfirm(title, 'Подарок снова станет доступен для других.', 'Да, отменить', async () => {
    await store.removeClaim(claim.id);
    toast('Готово, отменили');
  });
}

function renderGrid() {
  const grid = $('#grid');
  const gifts = sortedGifts();
  const visible = [];

  gifts.forEach((gift, index) => {
    const st = statusOf(gift.id);
    const claims = claimsOf(gift.id);
    const signature = JSON.stringify([gift, claims, index, store.me()]);
    let cached = cardCache.get(gift.id);
    if (!cached || cached.signature !== signature) {
      const el = buildCard(gift, index);
      if (cached) {
        el.classList.add('is-in');
        if (cached.kind !== 'booked' && st.kind === 'booked') el.classList.add('just-stamped');
      } else if (revealer && !reducedMotion()) {
        revealer.observe(el);
      } else {
        el.classList.add('is-in');
      }
      if (cached) cached.el.replaceWith(el);
      cached = { el, signature, kind: st.kind };
      cardCache.set(gift.id, cached);
    }
    if (filter === 'all' || filter === st.kind) visible.push(cached.el);
  });

  for (const id of cardCache.keys()) {
    if (!gifts.some((g) => g.id === id)) cardCache.delete(id);
  }

  const same = visible.length === grid.children.length
    && visible.every((el, i) => grid.children[i] === el);
  if (!same) grid.replaceChildren(...visible);

  const empty = $('#gridEmpty');
  empty.hidden = visible.length > 0 || !state.ready;
  if (gifts.length === 0) empty.textContent = 'Список пока пустой. Подарки скоро появятся.';
  else empty.textContent = filter === 'free' ? 'Свободных подарков больше нет.' : 'Пока никто не скидывается.';

  const free = gifts.filter((g) => statusOf(g.id).kind === 'free').length;
  $('#stats').textContent = gifts.length
    ? `${gifts.length} ${plural(gifts.length, 'подарок', 'подарка', 'подарков')}, свободно ${free}`
    : '';
}

function renderOthers() {
  const others = state.claims
    .filter((c) => c.type === 'other')
    .sort((a, b) => a.createdAt - b.createdAt);
  const mine = others.find((c) => c.uid === store.me());
  $('#otherBtn').textContent = mine ? 'Изменить мой подарок' : 'Дарю что-то другое';
  $('#otherList').replaceChildren(...others.map((c) => h('li', { class: 'other-item' },
    h('span', { class: 'person-mark', 'aria-hidden': 'true' }, c.name.trim().charAt(0).toUpperCase()),
    h('div', {},
      h('b', {}, c.name),
      h('span', {}, c.note || 'Дарит что-то своё')),
    c.uid === store.me()
      ? h('button', {
        type: 'button',
        class: 'btn-text on-dark',
        onclick: () => askConfirm('Убрать отметку?', 'Твоё имя исчезнет из этого списка.', 'Убрать', async () => {
          await store.removeClaim(c.id);
          toast('Отметку убрали');
        }),
      }, 'Убрать')
      : null)));
}

/* ---------- Брони ---------- */

function openClaim(type, gift, existing) {
  const name = h('input', {
    type: 'text', required: true, maxLength: 60, autocomplete: 'name',
    value: existing?.name || savedName(), placeholder: 'Например, Маша',
  });
  const note = h('input', {
    type: 'text', maxLength: 300, value: existing?.note || '',
    placeholder: type === 'other' ? 'Например, пока секрет' : 'Необязательно',
  });
  const amount = h('input', {
    type: 'number', min: 1, max: 10000000, step: 1, inputMode: 'numeric',
    value: existing?.amount || '', placeholder: 'Например, 2000',
  });

  const copy = {
    book: { title: 'Забронировать', action: 'Забронировать', done: 'Подарок твой! Больше его никто не возьмёт.' },
    chip: { title: 'Скинуться', action: existing ? 'Сохранить' : 'Скинуться', done: 'Ты в складчине!' },
    other: { title: 'Дарю другое', action: 'Отметиться', done: 'Записали!' },
  }[type];

  const submit = async () => {
    const who = name.value.trim();
    if (!who) {
      const err = new Error('empty');
      err.userMessage = 'Напиши своё имя.';
      throw err;
    }
    const payload = { name: who, note: note.value.trim() || undefined };
    if (type === 'book') await store.book(gift.id, payload);
    if (type === 'chip') {
      const sum = Number(amount.value);
      await store.chip(gift.id, { ...payload, amount: sum > 0 ? Math.round(sum) : undefined });
    }
    if (type === 'other') await store.other(payload);
    rememberName(who);
    closeSheet();
    toast(copy.done);
    if (!existing) confetti();
  };

  const fields = [field('Как тебя зовут', name)];
  if (type === 'chip') {
    fields.push(field('Сколько скинешь, ₽', amount, gift.price ? `Подарок стоит ${money(gift.price)}. Можно не указывать.` : 'Можно не указывать.'));
  }
  if (type === 'other') fields.push(field('Что даришь', note, 'Можно не указывать, если это сюрприз.'));
  if (type === 'book') fields.push(field('Комментарий', note));

  openSheet(
    h('p', { class: 'sheet-kicker' }, copy.title),
    h('h3', { class: 'sheet-title' }, gift ? gift.title : 'Свой подарок'),
    form(submit, copy.action, ...fields),
  );
  if (!name.value) name.focus();
}

$('#otherBtn').addEventListener('click', () => {
  const mine = state.claims.find((c) => c.type === 'other' && c.uid === store.me());
  openClaim('other', null, mine);
});

document.querySelectorAll('[data-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    filter = btn.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    renderGrid();
  });
});

/* ---------- Панель именинника ---------- */

async function compressPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const MAX_SIDE = 1100;
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  // Фото лежит прямо в базе, а там лимит на документ, поэтому держим его до ~300 КБ.
  let result = '';
  for (const quality of [0.82, 0.7, 0.58, 0.45]) {
    result = canvas.toDataURL('image/webp', quality);
    if (!result.startsWith('data:image/webp')) result = canvas.toDataURL('image/jpeg', quality);
    if (result.length < 400000) break;
  }
  return result;
}

function openGiftEditor(gift) {
  let photo = gift?.photo || '';
  const title = h('input', { type: 'text', required: true, maxLength: 120, value: gift?.title || '', placeholder: 'Что хочешь получить' });
  const price = h('input', { type: 'number', min: 0, step: 1, inputMode: 'numeric', value: gift?.price || '', placeholder: 'Например, 5000' });
  const url = h('input', { type: 'url', value: gift?.url || '', placeholder: 'https://…' });
  const note = h('textarea', { rows: 2, maxLength: 400, value: gift?.note || '', placeholder: 'Цвет, размер, модель' });

  const preview = h('div', { class: 'drop-preview' });
  const showPreview = () => {
    preview.replaceChildren(photo
      ? h('img', { src: photo, alt: '' })
      : h('span', {}, 'Нажми, чтобы выбрать фото'));
  };
  showPreview();

  const file = h('input', {
    type: 'file',
    accept: 'image/*',
    class: 'drop-input',
    onchange: async () => {
      if (!file.files[0]) return;
      preview.replaceChildren(h('span', {}, 'Сжимаю фото…'));
      try {
        photo = await compressPhoto(file.files[0]);
      } catch (err) {
        console.error(err);
        toast('Не получилось открыть это фото. Попробуй другое.', true);
      }
      showPreview();
    },
  });
  const drop = h('label', { class: 'drop' }, h('span', { class: 'field-label' }, 'Фото'), preview, file);

  const submit = async () => {
    const link = url.value.trim();
    if (!title.value.trim()) {
      const err = new Error('title');
      err.userMessage = 'Напиши название подарка.';
      throw err;
    }
    if (link && !safeUrl(link)) {
      const err = new Error('url');
      err.userMessage = 'Ссылка должна начинаться с https://';
      throw err;
    }
    const orders = state.gifts.map((g) => g.order ?? 0);
    await store.saveGift({
      ...(gift?.id ? { id: gift.id } : {}),
      title: title.value.trim(),
      price: Number(price.value) > 0 ? Math.round(Number(price.value)) : undefined,
      url: link || undefined,
      note: note.value.trim() || undefined,
      photo: photo || undefined,
      order: gift?.order ?? (orders.length ? Math.max(...orders) + 1 : 1),
    });
    closeSheet();
    toast(gift ? 'Подарок обновлён' : 'Подарок добавлен');
  };

  openSheet(
    h('h3', { class: 'sheet-title' }, gift ? 'Изменить подарок' : 'Новый подарок'),
    form(submit, 'Сохранить', drop, field('Название', title), field('Цена, ₽', price), field('Ссылка на магазин', url), field('Описание', note)),
  );
}

function renderLogin(root) {
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const submit = async () => {
    try {
      await store.login(email.value.trim(), password.value);
    } catch (err) {
      if (err instanceof OfflineError) throw err;
      console.warn(err);
      const msg = new Error('login');
      msg.userMessage = 'Неверная почта или пароль.';
      throw msg;
    }
  };
  root.replaceChildren(
    h('div', { class: 'admin-login' },
      h('h1', { class: 'admin-title' }, 'Вход'),
      form(submit, 'Войти', field('Почта', email), field('Пароль', password)),
      h('a', { class: 'btn-text', href: '#' }, '← К вишлисту')),
  );
}

let settingsDirty = false;

function renderSettingsForm() {
  const s = settings();
  const title = h('input', { type: 'text', maxLength: 60, value: s.title || '', oninput: () => { settingsDirty = true; } });
  const date = h('input', { type: 'date', value: s.date || '', oninput: () => { settingsDirty = true; } });
  const text = h('textarea', { rows: 3, maxLength: 300, value: s.text || '', oninput: () => { settingsDirty = true; } });
  const submit = async () => {
    await store.saveSettings({ title: title.value.trim(), date: date.value, text: text.value.trim() });
    settingsDirty = false;
    toast('Сохранили');
  };
  return form(submit, 'Сохранить',
    field('Заголовок', title, 'Каждое слово встанет на отдельную строку.'),
    field('Дата дня рождения', date),
    field('Текст под заголовком', text));
}

function adminGiftRow(gift, i, gifts) {
  const claims = claimsOf(gift.id);
  const move = (dir) => async () => {
    try {
      await store.swapOrder(gift, gifts[i + dir]);
    } catch (err) {
      toast(explain(err), true);
    }
  };
  return h('li', { class: 'row' },
    h('div', { class: 'row-main' },
      gift.photo ? h('img', { class: 'row-thumb', src: gift.photo, alt: '' }) : h('div', { class: 'row-thumb row-thumb-empty' }),
      h('div', { class: 'row-info' },
        h('b', {}, gift.title),
        h('span', {}, gift.price ? money(gift.price) : 'Без цены')),
      h('div', { class: 'row-tools' },
        h('button', { type: 'button', class: 'icon-btn', disabled: i === 0, 'aria-label': 'Выше', onclick: move(-1) }, '↑'),
        h('button', { type: 'button', class: 'icon-btn', disabled: i === gifts.length - 1, 'aria-label': 'Ниже', onclick: move(1) }, '↓'),
        h('button', { type: 'button', class: 'btn-text', onclick: () => openGiftEditor(gift) }, 'Изменить'),
        h('button', {
          type: 'button',
          class: 'btn-text is-danger',
          onclick: () => askConfirm('Удалить подарок?', `«${gift.title}» исчезнет вместе с бронями и складчиной.`, 'Удалить', async () => {
            await store.deleteGift(gift.id);
            toast('Подарок удалён');
          }),
        }, 'Удалить'))),
    claims.length
      ? h('ul', { class: 'row-claims' }, claims.map((c) => claimRow(c)))
      : null);
}

function claimRow(c) {
  const label = c.type === 'book' ? 'бронь' : c.type === 'chip' ? 'складчина' : 'своё';
  return h('li', {},
    h('span', {}, h('b', {}, c.name), ` · ${label}`, c.amount ? ` · ${money(c.amount)}` : '', c.note ? ` · ${c.note}` : ''),
    h('button', {
      type: 'button',
      class: 'btn-text is-danger',
      onclick: () => askConfirm('Убрать отметку?', `Убрать отметку «${c.name}»?`, 'Убрать', async () => {
        await store.removeClaim(c.id);
        toast('Отметку убрали');
      }),
    }, 'Убрать'));
}

let adminBuilt = false;

function renderAdmin() {
  const root = $('#adminView');
  if (!store.isOwner()) {
    adminBuilt = false;
    renderLogin(root);
    return;
  }
  if (!adminBuilt) {
    adminBuilt = true;
    settingsDirty = false;
    root.replaceChildren(
      h('div', { class: 'wrap admin-inner' },
        h('div', { class: 'admin-head' },
          h('h1', { class: 'admin-title' }, 'Панель именинника'),
          h('div', { class: 'admin-head-links' },
            h('a', { class: 'btn btn-ghost', href: '#' }, 'Открыть вишлист'),
            store.mode === 'live'
              ? h('button', { type: 'button', class: 'btn-text', onclick: () => store.logout() }, 'Выйти')
              : null)),
        h('section', { class: 'panel' },
          h('div', { class: 'panel-head' },
            h('h2', {}, 'Подарки'),
            h('button', { type: 'button', class: 'btn btn-red', onclick: () => openGiftEditor(null) }, '+ Добавить подарок')),
          h('ul', { class: 'rows', id: 'adminGifts' })),
        h('section', { class: 'panel' }, h('h2', {}, 'Дарят своё'), h('ul', { class: 'row-claims', id: 'adminOthers' })),
        h('section', { class: 'panel', id: 'adminSettings' }, h('h2', {}, 'Шапка сайта'), renderSettingsForm())),
    );
  } else if (!settingsDirty && !$('#adminSettings').contains(document.activeElement)) {
    $('#adminSettings form').replaceWith(renderSettingsForm());
  }

  const gifts = sortedGifts();
  const list = $('#adminGifts');
  list.replaceChildren(...(gifts.length
    ? gifts.map((g, i) => adminGiftRow(g, i, gifts))
    : [h('li', { class: 'empty' }, 'Пока пусто. Добавь первый подарок.')]));

  const others = state.claims.filter((c) => c.type === 'other');
  $('#adminOthers').replaceChildren(...(others.length
    ? others.map((c) => claimRow(c))
    : [h('li', { class: 'muted' }, 'Пока никого.')]));
}

/* ---------- Маршруты и запуск ---------- */

const isAdminRoute = () => location.hash === '#admin';

function renderAll() {
  const admin = isAdminRoute();
  $('#guestView').hidden = admin;
  $('#adminView').hidden = !admin;
  if (admin) {
    renderAdmin();
  } else {
    adminBuilt = false;
    renderHero();
    renderGrid();
    renderOthers();
  }
}

window.addEventListener('hashchange', () => {
  renderAll();
  if (isAdminRoute()) scrollTo(0, 0);
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!isAdminRoute()) fitHeroTitle(); }, 120);
});

function buildMarquee() {
  const phrase = ['Бронируй', 'Скидывайся', 'Дари своё'];
  const items = Array.from({ length: 8 }, () => phrase).flat();
  $('#marquee').replaceChildren(...items.map((t) => h('span', {}, t)));
}

async function start() {
  buildMarquee();
  renderHero();
  document.fonts?.ready.then(fitHeroTitle);

  try {
    store = await createStore();
  } catch (err) {
    console.error(err);
    toast('Не удалось подключиться к базе. Обнови страницу.', true);
    return;
  }

  $('#demoBar').hidden = store.mode !== 'demo';
  store.onAuth(() => renderAll());
  store.subscribe((next) => {
    if (next.error) {
      toast(next.error.code === 'permission-denied'
        ? 'База не пускает: проверь правила Firestore.'
        : 'Нет связи с базой. Проверь интернет.', true);
      return;
    }
    state = next;
    renderAll();
  });
}

start();
