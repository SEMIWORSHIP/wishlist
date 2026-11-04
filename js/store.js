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

async function createLiveStore() {
  const fb = await import('../vendor/firebase.js');
  const app = fb.initializeApp(config.firebase);
  const auth = fb.getAuth(app);
  const db = fb.getFirestore(app);

  const data = { gifts: [], claims: [], settings: {}, ready: false };
  const loaded = { gifts: false, claims: false, settings: false };
  const listeners = new Set();
  const authListeners = new Set();
  const emit = () => {
    data.ready = loaded.gifts && loaded.claims && loaded.settings;
    listeners.forEach((fn) => fn({ ...data }));
  };

  const onError = (err) => {
    console.error('Firestore:', err);
    listeners.forEach((fn) => fn({ ...data, error: err }));
  };

  fb.onSnapshot(fb.collection(db, 'gifts'), (snap) => {
    data.gifts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    loaded.gifts = true;
    emit();
  }, onError);
  fb.onSnapshot(fb.collection(db, 'claims'), (snap) => {
    data.claims = snap.docs.map((d) => {
      const c = d.data();
      return { id: d.id, ...c, createdAt: c.createdAt?.toMillis?.() ?? Date.now() };
    });
    loaded.claims = true;
    emit();
  }, onError);
  fb.onSnapshot(fb.doc(db, 'settings', 'main'), (snap) => {
    data.settings = snap.exists() ? snap.data() : {};
    loaded.settings = true;
    emit();
  }, onError);

  fb.onAuthStateChanged(auth, () => {
    authListeners.forEach((fn) => fn());
    emit();
  });

  const ensureUser = async () => {
    if (auth.currentUser) return auth.currentUser;
    const cred = await withTimeout(fb.signInAnonymously(auth));
    return cred.user;
  };

  const writeClaim = async (id, body) => {
    const user = await ensureUser();
    const ref = fb.doc(db, 'claims', id(user.uid));
    try {
      await withTimeout(fb.setDoc(ref, clean({ ...body, uid: user.uid, createdAt: fb.serverTimestamp() })));
    } catch (err) {
      if (err.code === 'permission-denied') throw new TakenError();
      throw err;
    }
  };

  return {
    mode: 'live',
    subscribe(fn) { listeners.add(fn); fn({ ...data }); },
    onAuth(fn) { authListeners.add(fn); },
    me: () => auth.currentUser?.uid ?? null,
    // Показывает панель тому, кто вошёл по почте. Настоящую защиту данных дают правила Firestore.
    isOwner: () => !!auth.currentUser && !auth.currentUser.isAnonymous,

    book: (giftId, { name, note }) =>
      writeClaim(() => `${giftId}_book`, { type: 'book', giftId, name, note }),
    chip: (giftId, { name, note, amount }) =>
      writeClaim((uid) => `${giftId}_chip_${uid}`, { type: 'chip', giftId, name, note, amount }),
    other: ({ name, note }) =>
      writeClaim((uid) => `other_${uid}`, { type: 'other', name, note }),
    removeClaim: (id) => withTimeout(fb.deleteDoc(fb.doc(db, 'claims', id))),

    login: (email, password) => withTimeout(fb.signInWithEmailAndPassword(auth, email, password)),
    logout: () => fb.signOut(auth),

    async saveGift(gift) {
      const { id, ...body } = gift;
      const ref = id ? fb.doc(db, 'gifts', id) : fb.doc(fb.collection(db, 'gifts'));
      await withTimeout(fb.setDoc(ref, clean(body)));
    },
    async deleteGift(id) {
      const batch = fb.writeBatch(db);
      batch.delete(fb.doc(db, 'gifts', id));
      data.claims.filter((c) => c.giftId === id).forEach((c) => batch.delete(fb.doc(db, 'claims', c.id)));
      await withTimeout(batch.commit());
    },
    async swapOrder(a, b) {
      const batch = fb.writeBatch(db);
      batch.update(fb.doc(db, 'gifts', a.id), { order: b.order });
      batch.update(fb.doc(db, 'gifts', b.id), { order: a.order });
      await withTimeout(batch.commit());
    },
    saveSettings: (s) => withTimeout(fb.setDoc(fb.doc(db, 'settings', 'main'), s)),
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
