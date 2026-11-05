// Начало праздника по калининградскому времени.
const PARTY = new Date('2026-11-23T19:00:00+02:00').getTime();

const $ = (sel) => document.querySelector(sel);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/* ---------- Бегущая строка ---------- */

const phrases = ['23 ноября', '19:00', 'Тельмана 106', 'Хорошее настроение обязательно'];
const track = $('#marquee');
for (let i = 0; i < 8; i += 1) {
  for (const text of phrases) {
    const span = document.createElement('span');
    span.textContent = text;
    track.append(span);
  }
}

/* ---------- Отсчёт ---------- */

function tick() {
  const left = PARTY - Date.now();
  if (left <= 0) {
    $('#countTitle').textContent = Date.now() - PARTY < 6 * 3600 * 1000
      ? 'Уже началось, беги скорее!'
      : 'Спасибо всем, кто был рядом!';
    $('#count').hidden = true;
    return false;
  }
  const secs = Math.floor(left / 1000);
  const d = Math.floor(secs / 86400);
  const h = Math.floor(secs / 3600) % 24;
  const m = Math.floor(secs / 60) % 60;
  const s = secs % 60;
  const pad = (n) => String(n).padStart(2, '0');
  $('#cDays').textContent = pad(d);
  $('#cHours').textContent = pad(h);
  $('#cMins').textContent = pad(m);
  $('#cSecs').textContent = pad(s);
  $('#lDays').textContent = plural(d, 'день', 'дня', 'дней');
  $('#lHours').textContent = plural(h, 'час', 'часа', 'часов');
  $('#lMins').textContent = plural(m, 'минута', 'минуты', 'минут');
  $('#lSecs').textContent = plural(s, 'секунда', 'секунды', 'секунд');
  return true;
}
if (tick()) {
  const timer = setInterval(() => { if (!tick()) clearInterval(timer); }, 1000);
}

/* ---------- Конфетти и подсказки ---------- */

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2800);
}

function confetti() {
  if (reducedMotion()) return;
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.display = 'block';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = ['#FF4A1C', '#C8F135', '#141210', '#FFFDF8'];
  const bits = Array.from({ length: 110 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 140,
    y: innerHeight * 0.6,
    vx: (Math.random() - 0.5) * 16,
    vy: -8 - Math.random() * 14,
    w: 6 + Math.random() * 9,
    h: 8 + Math.random() * 13,
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
      ctx.globalAlpha = Math.max(0, 1 - t / 1800);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (t < 1800) requestAnimationFrame(frame);
    else canvas.style.display = 'none';
  })(start);
}

/* ---------- Нажатие на фото ---------- */

const lines = [
  'Да-да, это я. Жду тебя 23-го!',
  'Хорошее настроение не забудь',
  'Тельмана, 106. Запоминай!',
  'Хватит тыкать, лучше приходи',
  '19:00. Не опаздывай!',
];
let lineIndex = 0;
const me = $('#me');
me.addEventListener('click', () => {
  me.classList.remove('is-hop');
  void me.offsetWidth;
  me.classList.add('is-hop');
  toast(lines[lineIndex % lines.length]);
  lineIndex += 1;
  confetti();
});

/* ---------- Что взять с собой ---------- */

const boxes = [...document.querySelectorAll('#bring input')];
let celebrated = false;
for (const box of boxes) {
  box.addEventListener('change', () => {
    const left = boxes.filter((b) => !b.checked).length;
    const note = $('#bringNote');
    if (left === 0) {
      note.textContent = 'Всё собрано, можно выходить!';
      if (!celebrated) confetti();
      celebrated = true;
    } else {
      note.textContent = `Осталось ${left} ${plural(left, 'пункт', 'пункта', 'пунктов')}.`;
    }
  });
}

/* ---------- Движение в шапке ---------- */

if (!reducedMotion()) {
  const hero = $('#hero');
  const num = $('#heroNum');
  let queued = false;
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (scrollY < hero.offsetHeight) num.style.setProperty('--shift', `${Math.round(scrollY * 0.22)}px`);
    });
  }, { passive: true });

  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    hero.addEventListener('pointermove', (e) => {
      const x = e.clientX / innerWidth - 0.5;
      me.style.setProperty('--px', `${(x * -16).toFixed(1)}px`);
    });
  }
}
