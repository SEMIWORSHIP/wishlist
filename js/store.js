// Хранилище данных. Два варианта с одинаковым набором методов:
// live — Firebase, общий для всех гостей; demo — localStorage, только этот браузер.
import { config } from './config.js';

export class TakenError extends Error {}
export class OfflineError extends Error {}

const TIMEOUT_MS = 20000;

function withTimeout(promise) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new OfflineError('timeout')), TIMEOUT_MS);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

export async function createStore() {
  return config.firebase ? createLiveStore() : createDemoStore();
}

/* ---------- Firebase ---------- */

// Гостю подарки приходят обычным запросом, сначала без фото, а библиотека Firebase
// догружается уже после первой отрисовки. Иначе на телефоне список пуст 6-10 секунд.
const CACHE_KEY = 'wishlist-cache-v1';
const PHOTO_KEY = 'wishlist-photo-v1:';
const UID_KEY = 'wishlist-uid-v1';
const GIFT_FIELDS = ['title', 'price', 'url', 'note', 'order'];
const REST_TIMEOUT_MS = 10000;
const PHOTO_WORKERS = 3;
const SDK_DELAY_MS = 1200;

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* память занята или приватный режим */ }
}

function fromRest(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  return undefined;
}
function restFields(doc) {
  return Object.fromEntries(Object.entries(doc.fields ?? {}).map(([k, v]) => [k, fromRest(v)]));
}
const restId = (doc) => doc.name.split('/').pop();

async function createLiveStore() {
  const base = `https://firestore.googleapis.com/v1/projects/${config.firebase.projectId}/databases/(default)/documents`;
  const rest = async (path) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REST_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/${path}`, { signal: abort.signal });
      if (res.status === 404) return {};
      if (!res.ok) throw new Error(`Firestore REST ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const data = { gifts: [], claims: [], settings: {}, ready: false, giftsFull: false };
  const photos = new Map();
  const listeners = new Set();
  const authListeners = new Set();
  const emit = () => listeners.forEach((fn) => fn({ ...data }));
  const onError = (err) => {
    console.error('Firestore:', err);
    listeners.forEach((fn) => fn({ ...data, error: err }));
  };

  let plainGifts = [];
  let sdkClaims = false;
  let sdkSettings = false;
  let sdkPromise = null;
  let stopGifts = null;
  let keepWatchingGifts = false;
  let authUser = null;
  let uid = null;
  try { uid = localStorage.getItem(UID_KEY); } catch { /* приватный режим */ }

  /* Подарки для гостя: текст сразу, фото следом */

  const applyPhotos = () => {
    if (data.giftsFull) return;
    data.gifts = plainGifts.map((g) => {
      if (!photos.has(g.id)) return { ...g, photoPending: true };
      const photo = photos.get(g.id);
      return photo ? { ...g, photo } : g;
    });
  };

  const fetchPhoto = async (gift) => {
    const key = PHOTO_KEY + gift.id;
    const doc = await rest(`gifts/${gift.id}?mask.fieldPaths=photo`);
    const photo = restFields(doc).photo ?? '';
    photos.set(gift.id, photo);
    writeJson(key, { t: gift.updateTime, p: photo });
  };

  const loadPhotos = async () => {
    const queue = plainGifts.filter((g) => !photos.has(g.id));
    await Promise.all(Array.from({ length: PHOTO_WORKERS }, async () => {
      while (queue.length) {
        const gift = queue.shift();
        try {
          await fetchPhoto(gift);
        } catch (err) {
          console.warn('Фото не загрузилось:', gift.id, err);
          photos.set(gift.id, '');
        }
        applyPhotos();
        emit();
      }
    }));
  };

  const dropStalePhotos = () => {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(PHOTO_KEY) && !plainGifts.some((g) => PHOTO_KEY + g.id === k))
        .forEach((k) => localStorage.removeItem(k));
    } catch { /* приватный режим */ }
  };

  const restorePhoto = (gift) => {
    const stored = readJson(PHOTO_KEY + gift.id);
    if (stored?.t === gift.updateTime) photos.set(gift.id, stored.p);
  };

  const fetchFirstView = async () => {
    const mask = GIFT_FIELDS.map((f) => `mask.fieldPaths=${f}`).join('&');
    const [gifts, claims, settings] = await Promise.all([
      rest(`gifts?pageSize=300&${mask}`),
      sdkClaims ? null : rest('claims?pageSize=1000'),
      sdkSettings ? null : rest('settings/main'),
    ]);
    const before = new Map(plainGifts.map((g) => [g.id, g.updateTime]));
    plainGifts = (gifts.documents ?? []).map((d) => ({ id: restId(d), updateTime: d.updateTime, ...restFields(d) }));
    plainGifts.forEach((g) => {
      if (before.get(g.id) !== g.updateTime) photos.delete(g.id);
      if (!photos.has(g.id)) restorePhoto(g);
    });
    if (claims && !sdkClaims) data.claims = (claims.documents ?? []).map((d) => ({ id: restId(d), ...restFields(d) }));
    if (settings && !sdkSettings) data.settings = settings.name ? restFields(settings) : {};
    applyPhotos();
    data.ready = true;
    writeJson(CACHE_KEY, { gifts: plainGifts, claims: data.claims, settings: data.settings });
    dropStalePhotos();
    emit();
    loadPhotos();
  };

  /* Библиотека Firebase: живые брони, вход и запись */

  const watchAllGifts = (fb, db) => {
    if (stopGifts) return;
    stopGifts = fb.onSnapshot(fb.collection(db, 'gifts'), (snap) => {
      data.gifts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      data.giftsFull = true;
      data.ready = true;
      emit();
    }, onError);
  };

  const refresh = () => fetchFirstView().catch((err) => console.warn('Список не обновился:', err));

  const unwatchAllGifts = () => {
    stopGifts();
    stopGifts = null;
    data.giftsFull = false;
    applyPhotos();
    refresh();
  };

  const loadSdk = async () => {
    const fb = await import('../vendor/firebase.js');
    const app = fb.initializeApp(config.firebase);
    const auth = fb.getAuth(app);
    const db = fb.getFirestore(app);

    fb.onSnapshot(fb.collection(db, 'claims'), (snap) => {
      sdkClaims = true;
      data.claims = snap.docs.map((d) => {
        const c = d.data();
        return { id: d.id, ...c, createdAt: c.createdAt?.toMillis?.() ?? Date.now() };
      });
      emit();
    }, onError);
    fb.onSnapshot(fb.doc(db, 'settings', 'main'), (snap) => {
      sdkSettings = true;
      data.settings = snap.exists() ? snap.data() : {};
      emit();
    }, onError);

    fb.onAuthStateChanged(auth, (user) => {
      authUser = user;
      uid = user?.uid ?? null;
      try {
        if (uid) localStorage.setItem(UID_KEY, uid);
        else localStorage.removeItem(UID_KEY);
      } catch { /* приватный режим */ }
      if (user && !user.isAnonymous) watchAllGifts(fb, db);
      else if (stopGifts && !keepWatchingGifts) unwatchAllGifts();
      authListeners.forEach((fn) => fn());
      emit();
    });
    return { fb, auth, db };
  };

  const sdk = () => {
    sdkPromise ??= loadSdk().catch((err) => {
      sdkPromise = null;
      throw err;
    });
    return sdkPromise;
  };

  const ensureUser = async () => {
    const { fb, auth } = await withTimeout(sdk());
    await withTimeout(auth.authStateReady());
    if (auth.currentUser) return auth.currentUser;
    const cred = await withTimeout(fb.signInAnonymously(auth));
    return cred.user;
  };

  const writeClaim = async (id, body) => {
    const user = await ensureUser();
    const { fb, db } = await sdk();
    const ref = fb.doc(db, 'claims', id(user.uid));
    try {
      await withTimeout(fb.setDoc(ref, clean({ ...body, uid: user.uid, createdAt: fb.serverTimestamp() })));
    } catch (err) {
      if (err.code === 'permission-denied') throw new TakenError();
      throw err;
    }
  };

  /* Запуск */

  // Повторный заход: сразу показываем то, что видели в прошлый раз, и тихо обновляем.
  const cached = readJson(CACHE_KEY);
  if (cached?.gifts?.length) {
    plainGifts = cached.gifts;
    data.claims = cached.claims ?? [];
    data.settings = cached.settings ?? {};
    plainGifts.forEach(restorePhoto);
    applyPhotos();
    data.ready = true;
  }

  const startSdk = () => sdk().catch(onError);
  if (location.hash === '#admin') startSdk();
  addEventListener('hashchange', () => { if (location.hash === '#admin') startSdk(); });

  fetchFirstView()
    .then(() => setTimeout(startSdk, SDK_DELAY_MS))
    .catch((err) => {
      // Обычный запрос не прошёл: остаётся способ через библиотеку.
      console.warn('Быстрая загрузка не прошла:', err);
      keepWatchingGifts = true;
      return sdk().then(({ fb, db }) => watchAllGifts(fb, db)).catch(onError);
    });

  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && data.ready && !data.giftsFull) refresh();
  });

  return {
    mode: 'live',
    subscribe(fn) { listeners.add(fn); fn({ ...data }); },
    onAuth(fn) { authListeners.add(fn); },
    me: () => uid,
    // Показывает панель тому, кто вошёл по почте. Настоящую защиту данных дают правила Firestore.
    isOwner: () => !!authUser && !authUser.isAnonymous,

    book: (giftId, { name, note }) =>
      writeClaim(() => `${giftId}_book`, { type: 'book', giftId, name, note }),
    chip: (giftId, { name, note, amount }) =>
      writeClaim((id) => `${giftId}_chip_${id}`, { type: 'chip', giftId, name, note, amount }),
    other: ({ name, note }) =>
      writeClaim((id) => `other_${id}`, { type: 'other', name, note }),
    async removeClaim(id) {
      const { fb, db } = await withTimeout(sdk());
      await withTimeout(fb.deleteDoc(fb.doc(db, 'claims', id)));
    },

    async login(email, password) {
      const { fb, auth } = await withTimeout(sdk());
      await withTimeout(fb.signInWithEmailAndPassword(auth, email, password));
    },
    async logout() {
      const { fb, auth } = await sdk();
      await fb.signOut(auth);
    },

    async saveGift(gift) {
      const { fb, db } = await withTimeout(sdk());
      const { id, ...body } = gift;
      const ref = id ? fb.doc(db, 'gifts', id) : fb.doc(fb.collection(db, 'gifts'));
      await withTimeout(fb.setDoc(ref, clean(body)));
    },
    async deleteGift(id) {
      const { fb, db } = await withTimeout(sdk());
      const batch = fb.writeBatch(db);
      batch.delete(fb.doc(db, 'gifts', id));
      data.claims.filter((c) => c.giftId === id).forEach((c) => batch.delete(fb.doc(db, 'claims', c.id)));
      await withTimeout(batch.commit());
    },
    async swapOrder(a, b) {
      const { fb, db } = await withTimeout(sdk());
      const batch = fb.writeBatch(db);
      batch.update(fb.doc(db, 'gifts', a.id), { order: b.order });
      batch.update(fb.doc(db, 'gifts', b.id), { order: a.order });
      await withTimeout(batch.commit());
    },
    async saveSettings(s) {
      const { fb, db } = await withTimeout(sdk());
      await withTimeout(fb.setDoc(fb.doc(db, 'settings', 'main'), s));
    },
  };
}

/* ---------- Демо ---------- */

const DEMO_KEY = 'wishlist-demo-v1';

function demoSeed() {
  const gifts = [
    { id: 'g1', title: 'Беспроводные наушники', price: 18000, url: 'https://example.com', note: 'Чёрные, с шумоподавлением.', order: 1 },
    { id: 'g2', title: 'Кофемолка', price: 6500, note: 'Жерновая, чтобы молоть под воронку.', order: 2 },
    { id: 'g3', title: 'Гитарный педалборд', price: 12000, url: 'https://example.com', note: 'Размер примерно 60 на 30 см.', order: 3 },
    { id: 'g4', title: 'Рюкзак для ноутбука', price: 7900, order: 4 },
    { id: 'g5', title: 'Настольная игра', price: 4200, note: 'Любая для компании от 4 человек.', order: 5 },
    { id: 'g6', title: 'Сертификат в книжный', note: 'Подойдёт любая сумма.', order: 6 },
  ];
  const t = Date.now();
  const claims = [
    { id: 'g2_book', type: 'book', giftId: 'g2', uid: 'demo-a', name: 'Маша', createdAt: t },
    { id: 'g1_chip_demo-b', type: 'chip', giftId: 'g1', uid: 'demo-b', name: 'Дима', amount: 5000, createdAt: t },
    { id: 'g1_chip_demo-c', type: 'chip', giftId: 'g1', uid: 'demo-c', name: 'Лёша', amount: 3000, createdAt: t },
    { id: 'other_demo-d', type: 'other', uid: 'demo-d', name: 'Катя', note: 'Пока секрет', createdAt: t },
  ];
  return { gifts, claims, settings: {} };
}

function createDemoStore() {
  let db;
  try { db = JSON.parse(localStorage.getItem(DEMO_KEY)); } catch { db = null; }
  if (!db) db = demoSeed();

  let uid;
  try {
    uid = localStorage.getItem('wishlist-demo-uid');
    if (!uid) {
      uid = `demo-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('wishlist-demo-uid', uid);
    }
  } catch { uid = 'demo-me'; }

  const listeners = new Set();
  const commit = () => {
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(db));
    } catch (err) {
      console.warn('Демо-данные не сохранились:', err);
    }
    listeners.forEach((fn) => fn({ ...db, ready: true }));
  };
  const upsertClaim = (claim) => {
    db.claims = db.claims.filter((c) => c.id !== claim.id);
    db.claims.push(clean({ ...claim, uid, createdAt: Date.now() }));
    commit();
  };

  return {
    mode: 'demo',
    subscribe(fn) { listeners.add(fn); fn({ ...db, ready: true }); },
    onAuth() {},
    me: () => uid,
    isOwner: () => true,

    async book(giftId, { name, note }) {
      const id = `${giftId}_book`;
      const existing = db.claims.find((c) => c.id === id);
      if (existing && existing.uid !== uid) throw new TakenError();
      upsertClaim({ id, type: 'book', giftId, name, note });
    },
    async chip(giftId, { name, note, amount }) {
      upsertClaim({ id: `${giftId}_chip_${uid}`, type: 'chip', giftId, name, note, amount });
    },
    async other({ name, note }) {
      upsertClaim({ id: `other_${uid}`, type: 'other', name, note });
    },
    async removeClaim(id) {
      db.claims = db.claims.filter((c) => c.id !== id);
      commit();
    },

    async login() {},
    async logout() {},

    async saveGift(gift) {
      if (gift.id) {
        db.gifts = db.gifts.map((g) => (g.id === gift.id ? gift : g));
      } else {
        db.gifts.push({ ...gift, id: `g${Date.now()}` });
      }
      commit();
    },
    async deleteGift(id) {
      db.gifts = db.gifts.filter((g) => g.id !== id);
      db.claims = db.claims.filter((c) => c.giftId !== id);
      commit();
    },
    async swapOrder(a, b) {
      db.gifts = db.gifts.map((g) => {
        if (g.id === a.id) return { ...g, order: b.order };
        if (g.id === b.id) return { ...g, order: a.order };
        return g;
      });
      commit();
    },
    async saveSettings(s) {
      db.settings = s;
      commit();
    },
  };
}
