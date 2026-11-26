import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, deleteDoc, onSnapshot, collection } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const I18N = window.I18N || { ko: {}, th: {}, en: {} };
const TAWI_DOC = window.TAWI_DOC || { th: {}, thEn: {} };
const CUSTOM_FIREBASE_CONFIG = null;
const LOCAL_DATA_KEY = 'store_hr_payroll_local_data_v2';
const LOCAL_FB_CFG_KEY = 'store_hr_custom_fb_cfg_v2';
const ADMIN_AUTH_SESSION_KEY = 'store_hr_admin_unlocked_v2';
const SESSION_LANG_PREVIEW_KEY = 'store_hr_lang_preview_v2';
const KIOSK_DEFAULT_KEY = 'hr_kiosk_default';
const KIOSK_WAKELOCK_KEY = 'hr_kiosk_wakelock';

const DEFAULT_SHIFT_TEMPLATES = [
  { id: 'tpl_open', name: '오픈조 (Open)', start: '07:00', end: '16:00', breakMinutes: 60, color: 'amber' },
  { id: 'tpl_mid', name: '미들조 (Mid)', start: '09:00', end: '18:00', breakMinutes: 60, color: 'emerald' },
  { id: 'tpl_close', name: '마감조 (Close)', start: '12:00', end: '21:00', breakMinutes: 60, color: 'indigo' }
];

const DEFAULT_SETTINGS = {
  storeName: '매장 인사·급여 관리',
  storeTaxId: '',
  storeAddress: 'Chiang Rai, Thailand',
  timezone: 'Asia/Bangkok',
  adminPin: '000000',
  language: 'ko',
  currency: 'THB',
  otMultiplier: 1.5,
  holidayOtMultiplier: 2.0,
  lateGraceMinutes: 10,
  lateDeductionEnabled: true,
  ssoEnabled: true,
  ssoRateThb: 5,
  ssoCapThb: 875,
  standardWorkDays: 26,
  attendanceBonusEnabled: false,
  attendanceBonusAmount: 1000,
  prorataEnabled: true,
  weeklyOffDays: [0],
  shiftTemplates: DEFAULT_SHIFT_TEMPLATES,
  seeded: false
};

let db = null, auth = null, currentUser = null;
let activeAppId = 'store-hr-prod', syncMode = 'local', activeCustomConfigObj = null, unsubscribers = [];
let routeMode = 'admin', isAdminUnlocked = false, activeAdminTab = 'logs', previewLanguage = null;
let kioskSelectedEmpId = null, kioskPinBuffer = '', kioskStream = null, kioskVirtualMode = false, kioskConfirmTimer = null, camSessionToken = 0;
let tawiDocLang = 'th', currentTawiState = null, currentPayslipCtx = null, pendingConfirmAction = null;
let deferredInstallPrompt = null, wakeLockSentinel = null, wakeLockDesired = true, kioskIdleTimer = null;
let shiftWeekStartStr = getMondayOfWeek(getTodayStr());
let state = { settings: { ...DEFAULT_SETTINGS }, employees: [], attendance: [], leaves: [], holidays: [], adjustments: {}, closures: {}, schedules: {} };

function getLang() {
  const c = previewLanguage || state.settings.language || 'ko';
  return I18N[c] ? c : 'ko';
}
function tFor(lang, key, params = {}) {
  const useLang = I18N[lang] ? lang : 'ko';
  let val = (I18N[useLang] && I18N[useLang][key] !== undefined) ? I18N[useLang][key] : (I18N.ko ? I18N.ko[key] : undefined);
  if (val === undefined) return key;
  if (typeof val === 'string') {
    Object.keys(params).forEach(k => { val = val.replaceAll(`{${k}}`, String(params[k] ?? '')); });
  }
  return val;
}
function t(key, params = {}) {
  return tFor(getLang(), key, params);
}
function getDisplayStoreNameFor(lang) {
  const s = state.settings.storeName;
  return (!s || s === '매장 인사·급여 관리') ? tFor(lang, 'defaultStoreName') : s;
}
function getDisplayStoreName() {
  return getDisplayStoreNameFor(getLang());
}
function applyStaticI18n() {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.title = t('pageTitle');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')); });
  ['ko', 'th', 'en'].forEach(code => {
    const isCur = code === lang;
    document.querySelectorAll(`.lang-pill-${code}`).forEach(b => {
      b.className = `lang-pill-${code} px-2.5 py-1 rounded-lg transition ${isCur ? 'bg-white text-wood-700 shadow-sm font-extrabold' : 'text-stone-600 hover:text-warm-900'}`;
    });
    document.querySelectorAll(`.set-lang-btn-${code}`).forEach(b => {
      b.className = `set-lang-btn-${code} py-2 px-2 rounded-xl border text-xs font-bold transition ${isCur ? 'bg-wood-600 text-white border-wood-600 shadow-sm' : 'bg-white text-warm-800 border-warm-300 hover:bg-warm-100'}`;
    });
  });
  updateKioskClockOnce();
  updateWakeLockUI();
  updateFullscreenUI();
  updateDeviceKioskPinUI();
}

function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function formatDateObj(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDaysStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return formatDateObj(d);
}
function getMondayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return formatDateObj(d);
}
function getWeekDates(mondayStr) {
  const arr = [];
  for (let i = 0; i < 7; i++) arr.push(addDaysStr(mondayStr, i));
  return arr;
}
function getDaysInMonth(ym) {
  const [y, m] = String(ym || getCurrentMonthStr()).split('-').map(Number);
  if (!y || !m) return 30;
  return new Date(y, m, 0).getDate();
}
function getCurrentMonthStr() { return getTodayStr().slice(0, 7); }
function getNowTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function timeToMinutes(s) {
  if (!s || !s.includes(':')) return null;
  const p = s.split(':').map(Number);
  return (p.length < 2 || Number.isNaN(p[0]) || Number.isNaN(p[1])) ? null : p[0] * 60 + p[1];
}
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function formatMoney(amt) {
  return `฿${Math.round(Number(amt) || 0).toLocaleString('en-US')}`;
}
function getShiftTemplates() {
  return Array.isArray(state.settings.shiftTemplates) ? state.settings.shiftTemplates : DEFAULT_SHIFT_TEMPLATES;
}
function getShiftColorClasses(color) {
  const map = {
    amber: 'bg-amber-50 border-amber-300 text-amber-900',
    emerald: 'bg-emerald-50 border-emerald-300 text-emerald-900',
    sky: 'bg-sky-50 border-sky-300 text-sky-900',
    indigo: 'bg-indigo-50 border-indigo-300 text-indigo-900',
    rose: 'bg-rose-50 border-rose-300 text-rose-900',
    stone: 'bg-stone-100 border-stone-300 text-stone-800'
  };
  return map[color] || map.amber;
}
function showToast(msg, type = 'info') {
  const c = document.getElementById('toast-container'), el = document.createElement('div');
  if (!c) return;
  const st = { success: 'bg-emerald-700 text-white border-emerald-600', error: 'bg-rose-700 text-white border-rose-600', warning: 'bg-wood-600 text-white border-wood-500', info: 'bg-warm-900 text-white border-warm-800' };
  el.className = `pointer-events-auto px-4 py-3 rounded-2xl shadow-lg border text-xs sm:text-sm font-bold transition-all duration-300 ${st[type] || st.info}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(-8px)'; setTimeout(() => el.remove(), 300); }, 3200);
}
function copyTextSafe(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-9999px';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta); return ok;
}
function encodeCfgParam(cfg) {
  try {
    const j = JSON.stringify({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId, storageBucket: cfg.storageBucket || '', messagingSenderId: cfg.messagingSenderId || '', appId: cfg.appId });
    return btoa(unescape(encodeURIComponent(j))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch (e) { return ''; }
}
function decodeCfgParam(enc) {
  try {
    if (!enc) return null;
    let b = enc.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const p = JSON.parse(decodeURIComponent(escape(atob(b))));
    return (p && p.apiKey && p.projectId) ? p : null;
  } catch (e) { return null; }
}
function safeLocalGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
function safeLocalSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
function safeLocalRemove(k) { try { window.localStorage.removeItem(k); } catch (e) {} }

function isStandaloneMode() {
  return window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone === true;
}
function updateOfflineBanner() {
  const el = document.getElementById('kiosk-offline-banner');
  if (el) el.classList.toggle('hidden', navigator.onLine !== false);
}
function updatePwaInstallUI() {
  const kBtn = document.getElementById('btn-kiosk-install');
  const standalone = isStandaloneMode();
  if (kBtn) kBtn.classList.toggle('hidden', standalone || !deferredInstallPrompt);
  updateFullscreenUI();
}
function updateFullscreenUI() {
  const btn = document.getElementById('btn-kiosk-fullscreen');
  if (!btn) return;
  if (isStandaloneMode()) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  btn.textContent = document.fullscreenElement ? t('kioskFullscreenOff') : t('kioskFullscreenOn');
}
function updateDeviceKioskPinUI() {
  const btn = document.getElementById('btn-toggle-pin-kiosk');
  if (!btn) return;
  const pinned = safeLocalGet(KIOSK_DEFAULT_KEY) === '1';
  btn.textContent = pinned ? t('btnUnpinKioskDevice') : t('btnPinKioskDevice');
  btn.className = pinned
    ? 'px-3.5 py-2 rounded-xl border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold transition'
    : 'px-3.5 py-2 rounded-xl border border-warm-300 bg-warm-50 hover:bg-warm-100 text-warm-900 text-xs font-bold transition';
}
function updateWakeLockUI() {
  const btn = document.getElementById('btn-kiosk-wakelock');
  const dot = document.getElementById('wakelock-dot');
  const lbl = document.getElementById('wakelock-label');
  if (!btn || !dot || !lbl) return;
  const active = wakeLockSentinel !== null;
  btn.className = active
    ? 'px-2.5 py-1.5 rounded-xl border border-emerald-200 bg-emerald-50 text-[11px] font-bold text-emerald-800 hover:bg-emerald-100 transition flex items-center gap-1.5'
    : 'px-2.5 py-1.5 rounded-xl border border-warm-200 bg-white text-[11px] font-bold text-stone-600 hover:bg-warm-50 transition flex items-center gap-1.5';
  dot.className = active ? 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse' : 'w-2 h-2 rounded-full bg-stone-400';
  lbl.textContent = active ? t('kioskWakeOn') : t('kioskWakeOff');
}
async function acquireWakeLock(silent = false) {
  if (!('wakeLock' in navigator) || !navigator.wakeLock?.request) {
    if (!silent) showToast(t('toastWakeUnsupported'), 'warning');
    updateWakeLockUI();
    return false;
  }
  if (wakeLockSentinel) { updateWakeLockUI(); return true; }
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel = sentinel;
    sentinel.addEventListener('release', () => {
      if (wakeLockSentinel === sentinel) wakeLockSentinel = null;
      updateWakeLockUI();
    });
    updateWakeLockUI();
    return true;
  } catch (err) {
    if (!silent) showToast(t('toastWakeUnsupported'), 'warning');
    updateWakeLockUI();
    return false;
  }
}
async function releaseWakeLock() {
  if (wakeLockSentinel) {
    const s = wakeLockSentinel;
    wakeLockSentinel = null;
    try { await s.release(); } catch (e) {}
  }
  updateWakeLockUI();
}
function clearKioskIdleTimer() {
  if (kioskIdleTimer) { clearTimeout(kioskIdleTimer); kioskIdleTimer = null; }
}
function scheduleKioskIdleReset() {
  clearKioskIdleTimer();
  if (routeMode !== 'kiosk') return;
  kioskIdleTimer = setTimeout(() => {
    if (routeMode === 'kiosk' && (kioskSelectedEmpId || kioskPinBuffer.length > 0 || kioskStream)) {
      window.HR.kioskPinClear(true);
    }
  }, 30000);
}
function initPwaAndKioskHardware() {
  wakeLockDesired = safeLocalGet(KIOSK_WAKELOCK_KEY) !== '0';
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updatePwaInstallUI();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updatePwaInstallUI();
  });
  window.addEventListener('online', updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);
  document.addEventListener('fullscreenchange', updateFullscreenUI);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && routeMode === 'kiosk' && wakeLockDesired) {
      acquireWakeLock(true);
    }
  });
  const kioskEl = document.getElementById('kiosk-app');
  if (kioskEl) {
    const onKioskActivity = () => {
      if (routeMode !== 'kiosk') return;
      scheduleKioskIdleReset();
      if (wakeLockDesired && !wakeLockSentinel) acquireWakeLock(true);
    };
    ['pointerdown', 'click', 'keydown'].forEach(ev => kioskEl.addEventListener(ev, onKioskActivity, { passive: true }));
  }
  updateOfflineBanner();
  updatePwaInstallUI();
  updateWakeLockUI();
}

function resolveFirebaseSource() {
  const params = new URLSearchParams(window.location.search);
  if (CUSTOM_FIREBASE_CONFIG && CUSTOM_FIREBASE_CONFIG.apiKey && CUSTOM_FIREBASE_CONFIG.projectId) {
    activeCustomConfigObj = CUSTOM_FIREBASE_CONFIG;
    return { config: CUSTOM_FIREBASE_CONFIG, appId: CUSTOM_FIREBASE_CONFIG.projectId, isEnv: false };
  }
  const cfgParam = params.get('cfg');
  if (cfgParam) {
    const d = decodeCfgParam(cfgParam);
    if (d) { activeCustomConfigObj = d; safeLocalSet(LOCAL_FB_CFG_KEY, JSON.stringify(d)); return { config: d, appId: d.projectId, isEnv: false }; }
  }
  const saved = safeLocalGet(LOCAL_FB_CFG_KEY);
  if (saved) {
    try { const p = JSON.parse(saved); if (p && p.apiKey && p.projectId) { activeCustomConfigObj = p; return { config: p, appId: p.projectId, isEnv: false }; } } catch (e) {}
  }
  if (typeof window.__firebase_config !== 'undefined' && window.__firebase_config) {
    try {
      const e = typeof window.__firebase_config === 'string' ? JSON.parse(window.__firebase_config) : window.__firebase_config;
      if (e && e.apiKey) return { config: e, appId: (typeof window.__app_id !== 'undefined' && window.__app_id) ? window.__app_id : 'default-app-id', isEnv: true };
    } catch (e) {}
  }
  return null;
}

function fsCol(col) { return collection(db, 'artifacts', activeAppId, 'public', 'data', col); }
function fsDoc(col, id) { return doc(db, 'artifacts', activeAppId, 'public', 'data', col, id); }

async function initDataLayer() {
  const fb = resolveFirebaseSource();
  if (fb) {
    try {
      const subEl = document.getElementById('loader-subtext');
      if (subEl) subEl.textContent = t('loaderCloudSub');
      const app = initializeApp(fb.config, 'store_hr_' + Date.now());
      auth = getAuth(app); db = getFirestore(app); activeAppId = fb.appId;
      if (fb.isEnv && typeof window.__initial_auth_token !== 'undefined' && window.__initial_auth_token) await signInWithCustomToken(auth, window.__initial_auth_token);
      else await signInAnonymously(auth);
      currentUser = auth.currentUser;
      if (!currentUser) throw new Error('Auth missing');
      syncMode = 'cloud'; updateSyncBadges(); await attachFirestoreListeners(); return;
    } catch (err) {
      db = null; currentUser = null; syncMode = 'local'; showToast(t('toastCloudFallback'), 'warning');
    }
  } else { syncMode = 'local'; }
  updateSyncBadges(); loadLocalFallbackData();
  window.addEventListener('storage', e => {
    if (e.key === LOCAL_DATA_KEY && e.newValue) {
      try {
        const p = JSON.parse(e.newValue);
        state = {
          settings: { ...DEFAULT_SETTINGS, ...(p.settings || {}), currency: 'THB' },
          employees: p.employees || [],
          attendance: p.attendance || [],
          leaves: p.leaves || [],
          holidays: p.holidays || [],
          adjustments: p.adjustments || {},
          closures: p.closures || {},
          schedules: p.schedules || {}
        };
        renderAllActiveViews();
      } catch (err) {}
    }
  });
}

function attachFirestoreListeners() {
  unsubscribers.forEach(u => { try { u(); } catch (e) {} });
  unsubscribers = [];
  return new Promise(resolve => {
    let init = { settings: false, employees: false }, done = false;
    const check = async () => {
      if (!done && init.settings && init.employees) {
        done = true;
        if (!state.settings.seeded && state.employees.length === 0) await seedInitialSampleData();
        renderAllActiveViews(); resolve();
      }
    };
    unsubscribers.push(onSnapshot(fsDoc('config', 'store_settings'), s => { if (s.exists()) state.settings = { ...DEFAULT_SETTINGS, ...s.data(), currency: 'THB' }; init.settings = true; check(); renderAllActiveViews(); }, () => { init.settings = true; check(); }));
    unsubscribers.push(onSnapshot(fsCol('employees'), s => { state.employees = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); init.employees = true; check(); renderAllActiveViews(); }, () => { init.employees = true; check(); }));
    unsubscribers.push(onSnapshot(fsCol('attendance'), s => { state.attendance = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.clockInTs || 0) - (a.clockInTs || 0)); renderAllActiveViews(); }));
    unsubscribers.push(onSnapshot(fsCol('leaves'), s => { state.leaves = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.date || '').localeCompare(a.date || '')); renderAllActiveViews(); }));
    unsubscribers.push(onSnapshot(fsCol('holidays'), s => { state.holidays = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.date || '').localeCompare(b.date || '')); renderAllActiveViews(); }));
    unsubscribers.push(onSnapshot(fsCol('payroll_adjustments'), s => { const m = {}; s.docs.forEach(d => { m[d.id] = { id: d.id, ...d.data() }; }); state.adjustments = m; renderAllActiveViews(); }));
    unsubscribers.push(onSnapshot(fsCol('payroll_closures'), s => { const m = {}; s.docs.forEach(d => { m[d.id] = { id: d.id, ...d.data() }; }); state.closures = m; renderAllActiveViews(); }));
    unsubscribers.push(onSnapshot(fsCol('schedules'), s => { const m = {}; s.docs.forEach(d => { m[d.id] = { id: d.id, ...d.data() }; }); state.schedules = m; renderAllActiveViews(); }));
    setTimeout(() => { if (!done) { done = true; resolve(); } }, 4000);
  });
}

async function persistSettings(ns) {
  state.settings = { ...state.settings, ...ns, currency: 'THB' };
  if (syncMode === 'cloud' && db && currentUser) await setDoc(fsDoc('config', 'store_settings'), state.settings);
  else saveLocalFallbackData();
  renderAllActiveViews();
}
async function persistDoc(col, id, obj) {
  if (syncMode === 'cloud' && db && currentUser) await setDoc(fsDoc(col, id), obj);
  else { applyLocalMutation(col, id, obj, false); saveLocalFallbackData(); renderAllActiveViews(); }
}
async function removeDoc(col, id) {
  if (syncMode === 'cloud' && db && currentUser) await deleteDoc(fsDoc(col, id));
  else { applyLocalMutation(col, id, null, true); saveLocalFallbackData(); renderAllActiveViews(); }
}
function applyLocalMutation(col, id, obj, del) {
  if (col === 'payroll_adjustments') { if (del) delete state.adjustments[id]; else state.adjustments[id] = { id, ...obj }; return; }
  if (col === 'payroll_closures') { if (del) delete state.closures[id]; else state.closures[id] = { id, ...obj }; return; }
  if (col === 'schedules') { if (del) delete state.schedules[id]; else state.schedules[id] = { id, ...obj }; return; }
  const arr = state[col]; if (!Array.isArray(arr)) return;
  const idx = arr.findIndex(x => x.id === id);
  if (del) { if (idx !== -1) arr.splice(idx, 1); } else { const r = { id, ...obj }; if (idx !== -1) arr[idx] = r; else arr.unshift(r); }
}
function saveLocalFallbackData() { safeLocalSet(LOCAL_DATA_KEY, JSON.stringify(state)); }
function loadLocalFallbackData() {
  const raw = safeLocalGet(LOCAL_DATA_KEY);
  if (raw) {
    try {
      const p = JSON.parse(raw);
      state = {
        settings: { ...DEFAULT_SETTINGS, ...(p.settings || {}), currency: 'THB' },
        employees: p.employees || [],
        attendance: p.attendance || [],
        leaves: p.leaves || [],
        holidays: p.holidays || [],
        adjustments: p.adjustments || {},
        closures: p.closures || {},
        schedules: p.schedules || {}
      };
      return;
    } catch (e) {}
  }
  seedInitialSampleData();
}

function generateVirtualSelfieJpeg(name, label, time, bg = '#231F20') {
  const c = document.createElement('canvas'); c.width = 240; c.height = 180; const x = c.getContext('2d');
  x.fillStyle = bg; x.fillRect(0, 0, 240, 180);
  x.fillStyle = '#FDE68A'; x.beginPath(); x.arc(120, 66, 26, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#D97706'; x.beginPath(); x.arc(120, 152, 46, Math.PI, 0); x.fill();
  x.fillStyle = '#231F20'; x.beginPath(); x.arc(111, 62, 3, 0, Math.PI * 2); x.arc(129, 62, 3, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#231F20'; x.lineWidth = 2.5; x.beginPath(); x.arc(120, 70, 8, 0.15 * Math.PI, 0.85 * Math.PI); x.stroke();
  x.fillStyle = 'rgba(0,0,0,0.55)'; x.fillRect(8, 8, 108, 20);
  x.fillStyle = label.includes('IN') ? '#34D399' : '#FDA4AF'; x.font = 'bold 10px sans-serif'; x.fillText(label, 14, 21);
  x.fillStyle = 'rgba(0,0,0,0.72)'; x.fillRect(0, 150, 240, 30);
  x.fillStyle = '#FFF'; x.font = 'bold 11px sans-serif'; x.fillText(name.slice(0, 12), 10, 169);
  x.fillStyle = '#FCD34D'; x.textAlign = 'right'; x.fillText(time, 230, 169);
  return c.toDataURL('image/jpeg', 0.65);
}

async function seedInitialSampleData() {
  const today = getTodayStr(), ym = getCurrentMonthStr(), nowTs = Date.now();
  const emps = [
    { id: 'sample_emp_1', name: '민지 (Minji)', role: 'Manager', pin: '1111', payType: 'MONTHLY', baseRate: 22000, shiftStart: '09:00', shiftEnd: '18:00', breakMinutes: 60, weeklyDayOff: 0, annualLeaveQuota: 6, ssoEligible: true, attendanceBonusEligible: true, active: true, idNumber: '1-5799-00123-45-6', phone: '081-234-5678', bankName: 'Kasikorn (KBank)', bankAccount: '012-3-45678-9', hireDate: `${ym.slice(0, 4)}-01-10`, resignDate: '', isSample: true, createdAt: nowTs - 3000 },
    { id: 'sample_emp_2', name: '솜차이 (Somchai)', role: 'Barista', pin: '2222', payType: 'MONTHLY', baseRate: 16500, shiftStart: '09:00', shiftEnd: '18:00', breakMinutes: 60, weeklyDayOff: 0, annualLeaveQuota: 6, ssoEligible: true, attendanceBonusEligible: true, active: true, idNumber: '1-5799-00456-78-9', phone: '089-876-5432', bankName: 'SCB', bankAccount: '405-6-78901-2', hireDate: `${ym.slice(0, 4)}-03-15`, resignDate: '', isSample: true, createdAt: nowTs - 2000 },
    { id: 'sample_emp_3', name: '똔 (Ton)', role: 'Part-time', pin: '3333', payType: 'HOURLY', baseRate: 85, shiftStart: '11:00', shiftEnd: '17:00', breakMinutes: 30, weeklyDayOff: -1, annualLeaveQuota: 6, ssoEligible: false, attendanceBonusEligible: false, active: true, idNumber: '', phone: '086-111-2222', bankName: 'Krungthai', bankAccount: '111-2-33344-5', hireDate: `${ym.slice(0, 4)}-06-01`, resignDate: '', isSample: true, createdAt: nowTs - 1000 }
  ];
  const logs = [
    { id: 'sample_att_1', empId: 'sample_emp_1', date: today, clockIn: '08:54', clockOut: '', clockInTs: nowTs - 7200000, clockOutTs: null, lateMinutes: 0, inPhoto: generateVirtualSelfieJpeg('민지 (Minji)', 'IN · Clock In', `${today} 08:54`, '#1E293B'), outPhoto: '', note: 'Sample', isSample: true },
    { id: 'sample_att_2', empId: 'sample_emp_2', date: today, clockIn: '09:18', clockOut: '', clockInTs: nowTs - 5400000, clockOutTs: null, lateMinutes: 18, inPhoto: generateVirtualSelfieJpeg('솜차이 (Somchai)', 'IN · Clock In', `${today} 09:18`, '#334155'), outPhoto: '', note: 'Sample (Late)', isSample: true }
  ];
  const y = new Date(Date.now() - 86400000), ys = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  if (ys.startsWith(ym)) {
    logs.push({ id: 'sample_att_3', empId: 'sample_emp_1', date: ys, clockIn: '08:55', clockOut: '19:30', clockInTs: nowTs - 90000000, clockOutTs: nowTs - 52000000, lateMinutes: 0, inPhoto: generateVirtualSelfieJpeg('민지 (Minji)', 'IN · Clock In', `${ys} 08:55`, '#1E293B'), outPhoto: generateVirtualSelfieJpeg('민지 (Minji)', 'OUT · Clock Out', `${ys} 19:30`, '#3F3F46'), note: 'Sample (OT 1.5h)', isSample: true });
    logs.push({ id: 'sample_att_4', empId: 'sample_emp_3', date: ys, clockIn: '11:00', clockOut: '17:05', clockInTs: nowTs - 82000000, clockOutTs: nowTs - 60000000, lateMinutes: 0, inPhoto: generateVirtualSelfieJpeg('똔 (Ton)', 'IN · Clock In', `${ys} 11:00`, '#1E1B4B'), outPhoto: generateVirtualSelfieJpeg('똔 (Ton)', 'OUT · Clock Out', `${ys} 17:05`, '#312E81'), note: 'Sample (Hourly)', isSample: true });
  }
  await persistSettings({ ...DEFAULT_SETTINGS, seeded: true });
  for (const e of emps) await persistDoc('employees', e.id, e);
  for (const l of logs) await persistDoc('attendance', l.id, l);
  await persistDoc('leaves', 'sample_lv_1', { id: 'sample_lv_1', empId: 'sample_emp_2', date: `${ym}-05`, type: 'UNPAID', isPaid: false, status: 'APPROVED', reason: 'Personal (Sample)', isSample: true });
  await persistDoc('holidays', 'sample_hol_1', { id: 'sample_hol_1', date: `${ym}-15`, name: 'Chiang Rai Store Holiday (Sample)', isSample: true });
}

function detectRouteMode() {
  const modeParam = (new URLSearchParams(window.location.search).get('mode') || '').toLowerCase();
  if (modeParam === 'admin') return 'admin';
  if (modeParam === 'kiosk') return 'kiosk';
  if (safeLocalGet(KIOSK_DEFAULT_KEY) === '1') return 'kiosk';
  return 'admin';
}
function buildRoleUrl(mode) {
  const u = new URL(window.location.href); u.searchParams.set('mode', mode);
  if (activeCustomConfigObj && !CUSTOM_FIREBASE_CONFIG) { const e = encodeCfgParam(activeCustomConfigObj); if (e) u.searchParams.set('cfg', e); } else u.searchParams.delete('cfg');
  return u.toString();
}
function updateSyncBadges() {
  const isC = syncMode === 'cloud', bh = isC ? `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span>${escapeHtml(t('syncCloud'))}</span>` : `<span class="w-2 h-2 rounded-full bg-amber-500"></span><span>${escapeHtml(t('syncLocal'))}</span>`;
  const bc = isC ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-amber-50 text-amber-800 border-amber-200';
  ['kiosk-sync-badge', 'admin-sync-badge'].forEach(id => { const el = document.getElementById(id); if (el) { el.className = `px-2.5 py-1 rounded-full text-[11px] font-bold border flex items-center gap-1.5 shrink-0 ${bc}`; el.innerHTML = bh; } });
  const lp = document.getElementById('login-sync-pill'); if (lp) { lp.className = `px-2.5 py-1 rounded-full text-[11px] font-bold border ${bc}`; lp.textContent = isC ? t('syncCloudShort') : t('syncLocal'); }
  const ss = document.getElementById('settings-cloud-status'); if (ss) { ss.className = `px-3 py-1 rounded-full text-xs font-bold border ${bc}`; ss.textContent = isC ? t('syncConnected', { appId: activeAppId }) : t('syncDisconnected'); }
}

function applyRouteUI() {
  routeMode = detectRouteMode();
  try { const sl = window.sessionStorage.getItem(SESSION_LANG_PREVIEW_KEY); if (sl && I18N[sl]) previewLanguage = sl; } catch (e) {}
  ['kiosk-app', 'admin-login-screen', 'admin-app'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
  if (routeMode === 'kiosk') {
    document.getElementById('kiosk-app')?.classList.remove('hidden');
    startKioskClock(); stopKioskCamera(); updateOfflineBanner(); updatePwaInstallUI(); updateFullscreenUI();
    if (wakeLockDesired) acquireWakeLock(true); else updateWakeLockUI();
    renderAllActiveViews();
  } else {
    stopKioskCamera(); releaseWakeLock(); clearKioskIdleTimer();
    try { isAdminUnlocked = window.sessionStorage.getItem(ADMIN_AUTH_SESSION_KEY) === 'true'; } catch (e) {}
    document.getElementById(isAdminUnlocked ? 'admin-app' : 'admin-login-screen')?.classList.remove('hidden');
    renderAllActiveViews();
  }
}

function renderAllActiveViews() {
  applyStaticI18n();
  const sn = getDisplayStoreName();
  ['kiosk-store-name', 'admin-header-store-name'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = sn; });
  const lt = document.getElementById('login-store-title'); if (lt) lt.textContent = `${sn} · ${t('loginTitleSuffix')}`;
  updateSyncBadges(); updateCameraStatusUI();
  if (routeMode === 'kiosk') renderKioskView();
  else if (isAdminUnlocked) { renderLogsTab(); renderShiftsTab(); renderPayrollTab(); renderLeavesTab(); renderEmployeesTab(); renderSettingsTab(); }
}

let clockInterval = null;
function updateKioskClockOnce() {
  const dEl = document.getElementById('kiosk-date'), tEl = document.getElementById('kiosk-clock'); if (!dEl || !tEl) return;
  const now = new Date(), lang = getLang();
  if (lang === 'th') { const m = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']; dEl.textContent = `${t('daysFull')[now.getDay()]}ที่ ${now.getDate()} ${m[now.getMonth()]} ${now.getFullYear() + 543}`; }
  else if (lang === 'en') { const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; dEl.textContent = `${t('daysFull')[now.getDay()]}, ${m[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`; }
  else dEl.textContent = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 (${t('daysShort')[now.getDay()]})`;
  tEl.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}
function startKioskClock() { if (clockInterval) return; updateKioskClockOnce(); clockInterval = setInterval(updateKioskClockOnce, 1000); }

function updateCameraStatusUI() {
  const st = document.getElementById('kiosk-standby-overlay'), vt = document.getElementById('kiosk-virtual-overlay'), gd = document.getElementById('kiosk-cam-guide'), gdt = document.getElementById('kiosk-cam-guide-text'), cs = document.getElementById('kiosk-cam-status'), btn = document.getElementById('btn-kiosk-cam-toggle');
  if (!st || !vt || !cs || !btn) return;
  if (kioskVirtualMode) {
    st.classList.add('hidden'); vt.classList.remove('hidden'); gd?.classList.remove('hidden'); gdt?.classList.remove('hidden');
    cs.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800';
    cs.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500"></span> ${escapeHtml(t('camVirtualBadge'))}`; btn.textContent = t('camTryReal');
  } else if (kioskStream) {
    st.classList.add('hidden'); vt.classList.add('hidden'); gd?.classList.remove('hidden'); gdt?.classList.remove('hidden');
    cs.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800';
    cs.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> ${escapeHtml(t('camWorking'))}`; btn.textContent = t('camSwitchVirtual');
  } else {
    st.classList.remove('hidden'); vt.classList.add('hidden'); gd?.classList.add('hidden'); gdt?.classList.add('hidden');
    cs.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-stone-100 text-stone-700';
    cs.innerHTML = `<span class="w-2 h-2 rounded-full bg-stone-400"></span> ${escapeHtml(t('camStandbyBadge'))}`; btn.textContent = t('camSwitchVirtual');
  }
}

function stopKioskCamera() {
  camSessionToken++;
  if (kioskStream) { try { kioskStream.getTracks().forEach(tr => tr.stop()); } catch (e) {} kioskStream = null; }
  const v = document.getElementById('kiosk-video'); if (v) { try { v.srcObject = null; } catch (e) {} }
  updateCameraStatusUI();
}

async function initKioskCamera() {
  if (kioskVirtualMode) { updateCameraStatusUI(); return false; }
  if (kioskStream) { updateCameraStatusUI(); return true; }
  const myToken = ++camSessionToken, video = document.getElementById('kiosk-video');
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (myToken !== camSessionToken || kioskVirtualMode) { stream.getTracks().forEach(tr => tr.stop()); updateCameraStatusUI(); return false; }
      kioskStream = stream; video.srcObject = kioskStream;
      await new Promise(res => {
        if (video.readyState >= 2 && video.videoWidth > 0) return res();
        const onR = () => { cl(); res(); }, tm = setTimeout(() => { cl(); res(); }, 1200);
        const cl = () => { clearTimeout(tm); video.removeEventListener('loadeddata', onR); video.removeEventListener('playing', onR); };
        video.addEventListener('loadeddata', onR); video.addEventListener('playing', onR);
      });
      updateCameraStatusUI(); return true;
    }
  } catch (err) { kioskVirtualMode = true; }
  updateCameraStatusUI(); return false;
}

function captureCompressedSelfie(empName, actionLabel) {
  const timeLabel = `${getTodayStr()} ${getNowTimeStr()}`;
  if (!kioskVirtualMode && kioskStream) {
    const v = document.getElementById('kiosk-video'), c = document.getElementById('kiosk-capture-canvas'), vw = v.videoWidth || 640, vh = v.videoHeight || 480, sc = Math.min(1, 240 / vw), w = Math.round(vw * sc), h = Math.round(vh * sc);
    c.width = w; c.height = h; const x = c.getContext('2d'); x.save(); x.scale(-1, 1); x.drawImage(v, -w, 0, w, h); x.restore();
    x.fillStyle = 'rgba(0,0,0,0.68)'; x.fillRect(0, h - 24, w, 24); x.fillStyle = '#FFF'; x.font = 'bold 10px sans-serif'; x.fillText(`${empName.slice(0, 10)} · ${actionLabel}`, 6, h - 8);
    x.fillStyle = '#FCD34D'; x.textAlign = 'right'; x.fillText(getNowTimeStr(), w - 6, h - 8); return c.toDataURL('image/jpeg', 0.65);
  }
  return generateVirtualSelfieJpeg(empName, actionLabel, timeLabel, actionLabel.includes('IN') ? '#064E3B' : '#4C0519');
}

function renderKioskView() {
  const activeEmps = state.employees.filter(e => e.active !== false), grid = document.getElementById('kiosk-emp-grid'); if (!grid) return;
  const today = getTodayStr();
  const sel = activeEmps.find(e => e.id === kioskSelectedEmpId);
  document.getElementById('kiosk-selected-label').textContent = sel ? sel.name : t('notSelected');
  if (kioskPinBuffer.length < 4) document.getElementById('kiosk-pin-hint').textContent = sel ? t('kioskPinHintEmp', { name: sel.name }) : t('kioskPinHintDefault');
  grid.innerHTML = activeEmps.length === 0 ? `<div class="col-span-full py-6 text-center text-xs text-stone-400">${escapeHtml(t('kioskNoActiveEmp'))}</div>` : activeEmps.map(e => {
    const s = kioskSelectedEmpId === e.id;
    const eff = getEffectiveShiftForDate(e, today);
    const shiftLine = eff.fromSchedule
      ? `<div class="text-[10px] mt-1 font-mono font-bold truncate ${s ? 'text-amber-200' : (eff.isScheduledOff ? 'text-rose-600' : 'text-wood-700')}">${eff.isScheduledOff ? 'OFF' : `${escapeHtml(eff.shiftName)} ${escapeHtml(eff.shiftStart)}~${escapeHtml(eff.shiftEnd)}`}</div>`
      : '';
    return `<button type="button" onclick="HR.selectKioskEmp('${e.id}')" class="touch-btn p-3 rounded-2xl border text-left transition ${s ? 'bg-wood-600 text-white border-wood-600 shadow-md' : 'bg-warm-50 hover:bg-warm-100 text-warm-900 border-warm-200'}"><div class="font-extrabold text-sm truncate">${escapeHtml(e.name)}</div><div class="text-[11px] truncate ${s ? 'text-amber-100' : 'text-stone-500'}">${escapeHtml(e.role)}</div>${shiftLine}</button>`;
  }).join('');
  const logs = state.attendance.filter(l => l.date === today), wk = logs.filter(l => l.clockIn && !l.clockOut).length;
  document.getElementById('kiosk-today-count').textContent = t('kioskTodayCount', { w: wk, t: logs.length });
  document.getElementById('kiosk-today-chips').innerHTML = logs.length === 0 ? `<span class="text-xs text-stone-400">${escapeHtml(t('kioskTodayEmpty'))}</span>` : logs.map(l => {
    const emp = state.employees.find(e => e.id === l.empId), name = emp ? emp.name.split(' ')[0] : 'Staff', w = l.clockIn && !l.clockOut;
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-bold border ${w ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-stone-100 text-stone-600 border-stone-200'}"><span class="w-1.5 h-1.5 rounded-full ${w ? 'bg-emerald-500' : 'bg-stone-400'}"></span>${escapeHtml(name)} ${l.clockIn}${l.clockOut ? ' ~ ' + l.clockOut : ' ' + escapeHtml(t('kioskWorkingStatus'))}</span>`;
  }).join('');
}
function updateKioskPinDots() { for (let i = 0; i < 4; i++) { const d = document.getElementById(`k-dot-${i}`); if (d) d.className = i < kioskPinBuffer.length ? 'w-4 h-4 rounded-full border-2 border-wood-600 bg-wood-600 scale-110 transition-all' : 'w-4 h-4 rounded-full border-2 border-stone-400 bg-transparent transition-all'; } }
function showKioskConfirmOverlay(empName, dir, timeStr, photoUrl, noteText) {
  const ov = document.getElementById('kiosk-confirm-overlay'), badge = document.getElementById('kiosk-confirm-badge'), bar = document.getElementById('kiosk-confirm-bar');
  badge.className = `inline-block px-4 py-1.5 rounded-full text-sm font-extrabold ${dir === 'IN' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`;
  badge.textContent = dir === 'IN' ? t('kioskConfirmInBadge') : t('kioskConfirmOutBadge');
  document.getElementById('kiosk-confirm-name').textContent = empName; document.getElementById('kiosk-confirm-time').textContent = `${getTodayStr()} ${timeStr}`;
  document.getElementById('kiosk-confirm-photo').src = photoUrl; document.getElementById('kiosk-confirm-note').textContent = noteText;
  ov.classList.remove('hidden'); bar.style.transition = 'none'; bar.style.width = '100%';
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = 'width 1500ms linear'; bar.style.width = '0%'; }));
  if (kioskConfirmTimer) clearTimeout(kioskConfirmTimer); kioskConfirmTimer = setTimeout(() => ov.classList.add('hidden'), 1500);
}

function getEffectiveShiftForDate(emp, dateStr) {
  const sched = (emp && dateStr) ? state.schedules[`${dateStr}_${emp.id}`] : null;
  if (sched) {
    if (sched.isOff === true) {
      return {
        fromSchedule: true,
        isScheduledOff: true,
        shiftId: 'OFF',
        shiftName: t('shiftOffBadge'),
        shiftStart: emp.shiftStart || '09:00',
        shiftEnd: emp.shiftEnd || '18:00',
        breakMinutes: Number(emp.breakMinutes ?? 60),
        color: 'rose'
      };
    }
    return {
      fromSchedule: true,
      isScheduledOff: false,
      shiftId: sched.shiftId || '',
      shiftName: sched.shiftName || '',
      shiftStart: sched.start || emp.shiftStart || '09:00',
      shiftEnd: sched.end || emp.shiftEnd || '18:00',
      breakMinutes: Number(sched.breakMinutes ?? emp.breakMinutes ?? 60),
      color: sched.color || 'amber'
    };
  }
  return {
    fromSchedule: false,
    isScheduledOff: false,
    shiftId: '',
    shiftName: '',
    shiftStart: emp?.shiftStart || '09:00',
    shiftEnd: emp?.shiftEnd || '18:00',
    breakMinutes: Number(emp?.breakMinutes ?? 60),
    color: 'stone'
  };
}

function isDateHolidayForEmployee(dateStr, emp) {
  if (!dateStr) return false;
  if (state.holidays.some(h => h.date === dateStr)) return true;
  const sched = emp ? state.schedules[`${dateStr}_${emp.id}`] : null;
  if (sched) return sched.isOff === true;
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  if ((state.settings.weeklyOffDays || []).includes(dow)) return true;
  return !!(emp && typeof emp.weeklyDayOff === 'number' && emp.weeklyDayOff >= 0 && emp.weeklyDayOff === dow);
}

function analyzeAttendance(log, emp) {
  if (!emp) return { workedHours: 0, regularHours: 0, otHours: 0, holidayHours: 0, lateMins: 0, isHolidayWork: false, shiftName: '', shiftColor: 'stone', fromSchedule: false };
  const eff = getEffectiveShiftForDate(emp, log.date);
  const inM = timeToMinutes(log.clockIn), outM = timeToMinutes(log.clockOut), sStart = timeToMinutes(eff.shiftStart) ?? 540, sEnd = timeToMinutes(eff.shiftEnd) ?? 1080;
  const brk = Number(eff.breakMinutes ?? 60), grace = Number(state.settings.lateGraceMinutes ?? 10);
  const lateMins = (inM !== null && inM > sStart + grace) ? (inM - sStart) : 0, isHolidayWork = isDateHolidayForEmployee(log.date, emp);
  let wM = 0, rM = 0, oM = 0, hM = 0;
  if (inM !== null && outM !== null) {
    let diff = outM - inM; if (diff < 0) diff += 1440; if (diff >= 300 && brk > 0) diff = Math.max(0, diff - brk); wM = diff;
    let sNet = sEnd - sStart; if (sNet <= 0) sNet += 1440; if (sNet >= 300 && brk > 0) sNet = Math.max(60, sNet - brk);
    if (isHolidayWork) hM = wM; else if (wM > sNet + 15) { rM = sNet; oM = wM - sNet; } else rM = wM;
  }
  return { workedHours: +(wM / 60).toFixed(2), regularHours: +(rM / 60).toFixed(2), otHours: +(oM / 60).toFixed(2), holidayHours: +(hM / 60).toFixed(2), lateMins, isHolidayWork, shiftName: eff.shiftName, shiftColor: eff.color, fromSchedule: eff.fromSchedule };
}

function getEmployeeLeaveStats(emp, year) {
  const yStr = String(year);
  const quota = Number(emp?.annualLeaveQuota ?? 6);
  const used = state.leaves.filter(lv => lv.empId === emp.id && (lv.date || '').startsWith(yStr) && lv.type === 'ANNUAL' && lv.status === 'APPROVED').length;
  const sickUsed = state.leaves.filter(lv => lv.empId === emp.id && (lv.date || '').startsWith(yStr) && lv.type === 'SICK' && lv.status === 'APPROVED').length;
  return { quota, used, remaining: quota - used, sickUsed };
}

function getOldSelfieCleanupTargets() {
  const days = parseInt(document.getElementById('cleanup-days')?.value || '90', 10) || 90;
  const d = new Date();
  d.setDate(d.getDate() - days);
  const cutoffDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const targets = state.attendance.filter(log => log.date && log.date < cutoffDateStr && (log.inPhoto || log.outPhoto));
  const totalBytes = targets.reduce((sum, l) => sum + (l.inPhoto ? l.inPhoto.length : 0) + (l.outPhoto ? l.outPhoto.length : 0), 0);
  return { cutoffDateStr, targets, kb: Math.round(totalBytes / 1024) };
}

function calculateMonthlyPayroll(emp, targetMonth) {
  const logs = state.attendance.filter(l => l.empId === emp.id && (l.date || '').startsWith(targetMonth));
  let tw = 0, tr = 0, to = 0, th = 0, tl = 0;
  logs.forEach(l => { const a = analyzeAttendance(l, emp); tw += a.workedHours; tr += a.regularHours; to += a.otHours; th += a.holidayHours; tl += a.lateMins; });
  const approvedLeaves = state.leaves.filter(lv => lv.empId === emp.id && (lv.date || '').startsWith(targetMonth) && lv.status === 'APPROVED');
  const unpaidDays = approvedLeaves.filter(lv => lv.isPaid === false).length;
  const sickLeaveDays = approvedLeaves.filter(lv => lv.type === 'SICK').length;
  const stdDays = Number(state.settings.standardWorkDays || 26), otMult = Number(state.settings.otMultiplier || 1.5), holMult = Number(state.settings.holidayOtMultiplier || 2.0);
  const daysInMonth = getDaysInMonth(targetMonth);
  const monthStart = `${targetMonth}-01`, monthEnd = `${targetMonth}-${String(daysInMonth).padStart(2, '0')}`;
  let fullBasePay = 0, basePay = 0, hrEq = 0, dailyRate = 0;
  let isProrated = false, isNotEmployed = false, prorataEmployedDays = daysInMonth, prorataTotalDays = daysInMonth;

  if (emp.payType === 'MONTHLY') {
    fullBasePay = Number(emp.baseRate) || 0;
    hrEq = fullBasePay / (stdDays * 8);
    dailyRate = fullBasePay / stdDays;
    basePay = fullBasePay;
    if (state.settings.prorataEnabled !== false && (emp.hireDate || emp.resignDate)) {
      const effStart = (emp.hireDate && emp.hireDate > monthStart) ? emp.hireDate : monthStart;
      const effEnd = (emp.resignDate && emp.resignDate < monthEnd) ? emp.resignDate : monthEnd;
      if (effStart > effEnd) {
        isNotEmployed = true;
        prorataEmployedDays = 0;
        basePay = 0;
      } else {
        const d1 = new Date(effStart + 'T00:00:00'), d2 = new Date(effEnd + 'T00:00:00');
        prorataEmployedDays = Math.round((d2 - d1) / 86400000) + 1;
        if (prorataEmployedDays < daysInMonth) {
          isProrated = true;
          basePay = Math.round(fullBasePay * (prorataEmployedDays / daysInMonth));
        }
      }
    }
  } else {
    hrEq = Number(emp.baseRate) || 0;
    basePay = Math.round(tr * hrEq);
    fullBasePay = basePay;
  }

  const otPay = Math.round(to * hrEq * otMult), holidayPay = Math.round(th * hrEq * holMult);
  const lateDeduction = state.settings.lateDeductionEnabled ? Math.round((tl / 60) * hrEq) : 0;
  const unpaidDeduction = emp.payType === 'MONTHLY' ? Math.min(basePay, Math.round(unpaidDays * dailyRate)) : 0;
  const adj = state.adjustments[`${targetMonth}_${emp.id}`] || { bonus: 0, deduction: 0, wht: 0, memo: '' };
  const extraBonus = Number(adj.bonus) || 0, extraDeduction = Number(adj.deduction) || 0, whtDeduction = Number(adj.wht) || 0;
  const attBonusCfgAmt = Number(state.settings.attendanceBonusAmount) || 0;
  const attBonusEligible = emp.attendanceBonusEligible !== undefined ? !!emp.attendanceBonusEligible : (emp.payType === 'MONTHLY');
  const attendanceBonus = (state.settings.attendanceBonusEnabled === true && attBonusCfgAmt > 0 && attBonusEligible && !isProrated && !isNotEmployed && logs.length > 0 && tl === 0 && unpaidDays === 0 && sickLeaveDays === 0)
    ? attBonusCfgAmt
    : 0;

  const ssoDeduction = (state.settings.ssoEnabled && emp.ssoEligible)
    ? Math.min(Number(state.settings.ssoCapThb ?? 875), Math.round(basePay * ((Number(state.settings.ssoRateThb ?? 5)) / 100)))
    : 0;
  const employerSso = ssoDeduction;
  const totalEarnings = basePay + otPay + holidayPay + attendanceBonus + extraBonus;
  const totalDeductions = lateDeduction + unpaidDeduction + extraDeduction + ssoDeduction + whtDeduction;
  const netPay = Math.max(0, totalEarnings - totalDeductions);
  const employerTotalCost = totalEarnings + employerSso;
  return {
    emp, empId: emp.id, targetMonth, workDaysCount: logs.length,
    totalWorkedHours: +tw.toFixed(1), totalOtHours: +to.toFixed(1), totalHolidayHours: +th.toFixed(1),
    totalLateMins: tl, unpaidLeaveDays: unpaidDays,
    fullBasePay, basePay, isProrated, isNotEmployed, prorataEmployedDays, prorataTotalDays,
    otPay, holidayPay, attendanceBonus, extraBonus, extraDeduction, adjMemo: adj.memo || '',
    lateDeduction, unpaidDeduction, ssoDeduction, whtDeduction, employerSso,
    totalEarnings, totalDeductions, netPay, employerTotalCost,
    transferPaid: false, transferPaidAt: ''
  };
}

function getPayrollViewData(targetMonth) {
  const cl = state.closures[targetMonth];
  if (cl && Array.isArray(cl.rows)) {
    return {
      isClosed: true,
      closure: cl,
      rules: cl.rulesSnapshot || state.settings,
      rows: cl.rows.map(r => {
        const whtDeduction = Number(r.whtDeduction) || 0;
        const employerSso = r.employerSso ?? r.ssoDeduction ?? 0;
        const totalEarnings = Number(r.totalEarnings) || 0;
        const employerTotalCost = r.employerTotalCost ?? (totalEarnings + employerSso);
        return {
          ...r,
          attendanceBonus: Number(r.attendanceBonus) || 0,
          isProrated: !!r.isProrated,
          isNotEmployed: !!r.isNotEmployed,
          prorataEmployedDays: r.prorataEmployedDays ?? 0,
          prorataTotalDays: r.prorataTotalDays ?? 0,
          fullBasePay: r.fullBasePay ?? (Number(r.basePay) || 0),
          whtDeduction,
          employerSso,
          employerTotalCost,
          empId: r.empId || r.empSnapshot?.id,
          emp: r.empSnapshot || { id: r.empId, name: t('deletedEmp'), role: '', payType: 'MONTHLY', baseRate: 0, idNumber: '', bankName: '', bankAccount: '' }
        };
      })
    };
  }
  return { isClosed: false, closure: null, rules: state.settings, rows: state.employees.map(emp => calculateMonthlyPayroll(emp, targetMonth)) };
}

function computeThaiProgressiveTax(annualIncome, annualSso) {
  const expDed = Math.min(100000, annualIncome * 0.5);
  const personalDed = 60000;
  const ssoAnnualDed = Math.min(10500, annualSso);
  let taxable = Math.max(0, annualIncome - expDed - personalDed - ssoAnnualDed);
  const brackets = [
    [150000, 0], [150000, 0.05], [200000, 0.10], [250000, 0.15],
    [250000, 0.20], [1000000, 0.25], [3000000, 0.30], [Infinity, 0.35]
  ];
  let tax = 0;
  for (const [span, rate] of brackets) {
    if (taxable <= 0) break;
    const slice = Math.min(taxable, span);
    tax += slice * rate;
    taxable -= slice;
  }
  return tax;
}

function computeAnnualTaxSummary(year) {
  let closedCount = 0;
  const map = new Map();
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, '0')}`;
    const view = getPayrollViewData(ym);
    if (view.isClosed) closedCount++;
    view.rows.forEach(r => {
      const hasActivity = view.isClosed || r.workDaysCount > 0 || r.extraBonus > 0 || (r.attendanceBonus || 0) > 0 || r.whtDeduction > 0 || r.extraDeduction > 0;
      if (!hasActivity) return;
      const eid = r.empId || r.emp.id;
      const liveEmp = state.employees.find(e => e.id === eid);
      if (!map.has(eid)) {
        map.set(eid, { empId: eid, emp: liveEmp ? { ...r.emp, ...liveEmp } : r.emp, gross: 0, wht: 0, empSso: 0, erSso: 0, net: 0, months: [] });
      }
      const rec = map.get(eid);
      rec.gross += Number(r.totalEarnings) || 0;
      rec.wht += Number(r.whtDeduction) || 0;
      rec.empSso += Number(r.ssoDeduction) || 0;
      rec.erSso += Number(r.employerSso) || 0;
      rec.net += Number(r.netPay) || 0;
      rec.months.push({ ym, isClosed: view.isClosed, gross: Number(r.totalEarnings) || 0, wht: Number(r.whtDeduction) || 0, empSso: Number(r.ssoDeduction) || 0, erSso: Number(r.employerSso) || 0, net: Number(r.netPay) || 0 });
    });
  }
  return { year, closedCount, items: Array.from(map.values()) };
}

function renderPayslipDocument() {
  if (!currentPayslipCtx || currentPayslipCtx.type !== 'payslip') return;
  const { empId, month: m, lang } = currentPayslipCtx;
  ['th', 'ko', 'en'].forEach(code => {
    const isCur = code === lang;
    document.querySelectorAll(`.payslip-lang-btn-${code}`).forEach(b => {
      b.className = `payslip-lang-btn-${code} px-2.5 py-1 rounded-lg transition ${isCur ? 'bg-white text-wood-700 shadow-sm font-extrabold' : 'text-stone-600 hover:text-warm-900'}`;
    });
  });

  const view = getPayrollViewData(m), r = view.rows.find(x => (x.empId || x.emp?.id) === empId);
  if (!r) return;
  const emp = r.emp, rules = view.rules;
  const storeMeta = [state.settings.storeTaxId ? `Tax ID: ${state.settings.storeTaxId}` : '', state.settings.storeAddress || ''].filter(Boolean).join(' · ');
  const bankInfo = (emp.bankName || emp.bankAccount) ? `<p class="text-xs text-stone-600 bg-warm-50 px-3.5 py-2 rounded-xl border border-warm-200">${escapeHtml(tFor(lang, 'payslipBankAccount', { bank: emp.bankName || '-', account: emp.bankAccount || '' }))}</p>` : '';
  const closedBadge = view.isClosed ? `<span class="ml-2 px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-extrabold align-middle">[${escapeHtml(tFor(lang, 'payslipClosedBadge'))}]</span>` : '';
  const basePayLabel = r.isNotEmployed
    ? `${tFor(lang, 'payslipBasePay')} (${tFor(lang, 'badgeNotEmployed')})`
    : (r.isProrated ? `${tFor(lang, 'payslipBasePay')} (${tFor(lang, 'payslipProrataNote', { d: r.prorataEmployedDays, t: r.prorataTotalDays })})` : tFor(lang, 'payslipBasePay'));

  document.getElementById('payslip-print-area').innerHTML = `
    <div class="border-b-2 border-warm-900 pb-4 flex items-start justify-between gap-4">
      <div><span class="text-xs font-extrabold uppercase tracking-widest text-wood-600">${escapeHtml(getDisplayStoreNameFor(lang))} · PAYSLIP</span><h3 class="text-2xl font-extrabold text-warm-900 mt-0.5">${escapeHtml(tFor(lang, 'payslipTitle', { month: m }))}${closedBadge}</h3>${storeMeta ? `<p class="text-[11px] text-stone-500 mt-1">${escapeHtml(storeMeta)}</p>` : ''}</div>
      <div class="text-right text-xs text-stone-500 shrink-0"><p class="font-extrabold text-warm-900 text-sm">${escapeHtml(emp.name)}</p><p>${escapeHtml(emp.role)} (${escapeHtml(emp.payType === 'MONTHLY' ? tFor(lang, 'payTypeMonthly') : tFor(lang, 'payTypeHourly'))})</p><p class="mt-0.5">${escapeHtml(tFor(lang, 'payslipIssuedAt', { date: view.isClosed ? (view.closure.closedDate || getTodayStr()) : getTodayStr() }))}</p></div>
    </div>${bankInfo}
    <div class="grid grid-cols-3 gap-2 bg-warm-50 p-3.5 rounded-2xl border border-warm-200 text-xs">
      <div><span class="text-stone-500 block">${escapeHtml(tFor(lang, 'payslipWorkDays'))}</span><strong class="text-warm-900 text-sm">${escapeHtml(tFor(lang, 'payslipWorkUnit', { d: r.workDaysCount }))}</strong></div>
      <div><span class="text-stone-500 block">${escapeHtml(tFor(lang, 'payslipHoursBreakdown'))}</span><strong class="text-warm-900 text-sm">${r.totalWorkedHours}h / ${r.totalOtHours}h / ${r.totalHolidayHours}h</strong></div>
      <div><span class="text-stone-500 block">${escapeHtml(tFor(lang, 'payslipLateUnpaid'))}</span><strong class="text-warm-900 text-sm">${escapeHtml(tFor(lang, 'payslipLateUnpaidVal', { m: r.totalLateMins, d: r.unpaidLeaveDays }))}</strong></div>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
      <div class="border border-warm-200 rounded-2xl p-4 space-y-2.5"><h4 class="font-extrabold text-emerald-800 border-b border-warm-100 pb-1.5 text-xs uppercase">${escapeHtml(tFor(lang, 'payslipEarningsTitle'))}</h4><div class="flex justify-between gap-2"><span>${escapeHtml(basePayLabel)}</span><span class="font-mono font-bold shrink-0">${formatMoney(r.basePay)}</span></div><div class="flex justify-between"><span>${escapeHtml(tFor(lang, 'payslipOtPay', { x: rules.otMultiplier ?? 1.5 }))}</span><span class="font-mono font-bold">${formatMoney(r.otPay)}</span></div><div class="flex justify-between"><span>${escapeHtml(tFor(lang, 'payslipHolPay', { x: rules.holidayOtMultiplier ?? 2.0 }))}</span><span class="font-mono font-bold">${formatMoney(r.holidayPay)}</span></div><div class="flex justify-between"><span>${escapeHtml(tFor(lang, 'payslipAttBonus'))}</span><span class="font-mono font-bold">${formatMoney(r.attendanceBonus || 0)}</span></div><div class="flex justify-between"><span>${escapeHtml(tFor(lang, 'payslipExtraBonus'))}</span><span class="font-mono font-bold">${formatMoney(r.extraBonus)}</span></div><div class="flex justify-between pt-2 border-t border-warm-200 font-extrabold text-warm-900"><span>${escapeHtml(tFor(lang, 'payslipTotalEarnings'))}</span><span class="font-mono">${formatMoney(r.totalEarnings)}</span></div></div>
      <div class="border border-warm-200 rounded-2xl p-4 space-y-2.5"><h4 class="font-extrabold text-rose-800 border-b border-warm-100 pb-1.5 text-xs uppercase">${escapeHtml(tFor(lang, 'payslipDeductionsTitle'))}</h4><div class="flex justify-between"><span>${escapeHtml(tFor(lang, 'payslipLateDed', { m: r.totalLateMins }))}</span><span class="font-mono font-bold">${formatMoney(r.lateDeduction)}</span></div><div class="flex justify-between"><span>${escapeHtml(tFor(lang, 'payslipUnpaidDed', { d: r.unpaidLeaveDays }))}</span><span class="font-mono font-bold">${formatMoney(r.unpaidDeduction)}</span></div><div class="flex justify-between"><span>${escapeHtml(tFor(lang, 'payslipSsoDed'))}</span><span class="font-mono font-bold">${formatMoney(r.ssoDeduction)}</span></div><div class="flex justify-between"><span>${escapeHtml(tFor(lang, 'payslipWhtDed'))}</span><span class="font-mono font-bold">${formatMoney(r.whtDeduction)}</span></div><div class="flex justify-between"><span>${escapeHtml(tFor(lang, 'payslipExtraDed'))}</span><span class="font-mono font-bold">${formatMoney(r.extraDeduction)}</span></div><div class="flex justify-between pt-2 border-t border-warm-200 font-extrabold text-rose-700"><span>${escapeHtml(tFor(lang, 'payslipTotalDeductions'))}</span><span class="font-mono">${formatMoney(r.totalDeductions)}</span></div></div>
    </div>
    ${r.adjMemo ? `<p class="text-xs text-stone-500 bg-warm-50 px-3.5 py-2 rounded-xl border border-warm-200"><strong>${escapeHtml(tFor(lang, 'payslipAdjMemo'))}</strong> ${escapeHtml(r.adjMemo)}</p>` : ''}
    <div class="bg-warm-900 text-white rounded-2xl p-4 flex items-center justify-between"><div><span class="text-xs text-stone-300">${escapeHtml(tFor(lang, 'payslipNetLabel'))}</span><p class="text-[11px] text-stone-400">${escapeHtml(tFor(lang, 'payslipNetSub'))}</p></div><span class="text-2xl font-extrabold font-mono text-amber-300">${formatMoney(r.netPay)}</span></div>
    <p class="text-[11px] text-stone-500 text-right">${escapeHtml(tFor(lang, 'payslipEmployerSsoNote', { amt: formatMoney(r.employerSso) }))}</p>`;
}

function buildPayslipImageFilename() {
  let rawName = 'staff';
  if (currentPayslipCtx?.type === 'tawi') {
    const it = computeAnnualTaxSummary(currentPayslipCtx.year).items.find(x => x.empId === currentPayslipCtx.empId);
    rawName = it?.emp?.name || 'staff';
    const safeName = String(rawName).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'staff';
    return `50tawi_${currentPayslipCtx.year}_${safeName}_${currentPayslipCtx.docLang || 'th'}.png`;
  }
  if (currentPayslipCtx?.type === 'payslip') {
    const view = getPayrollViewData(currentPayslipCtx.month);
    const r = view.rows.find(x => (x.empId || x.emp?.id) === currentPayslipCtx.empId);
    rawName = r?.emp?.name || 'staff';
    const safeName = String(rawName).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'staff';
    return `payslip_${currentPayslipCtx.month}_${safeName}_${currentPayslipCtx.lang || 'ko'}.png`;
  }
  return `payslip_${getTodayStr()}.png`;
}

async function capturePayslipToBlob() {
  if (typeof window.html2canvas !== 'function') throw new Error('html2canvas missing');
  const src = document.getElementById('payslip-print-area');
  if (!src) throw new Error('Print area missing');
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
  const wrap = document.createElement('div');
  wrap.className = 'font-sans text-warm-900 bg-white';
  wrap.style.cssText = 'width:720px;padding:32px;background:#ffffff;position:fixed;left:-99999px;top:0;z-index:-1;box-sizing:border-box;';
  const clone = src.cloneNode(true);
  clone.removeAttribute('id');
  wrap.appendChild(clone);
  document.body.appendChild(wrap);
  try {
    const canvas = await window.html2canvas(wrap, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });
    return blob;
  } finally {
    wrap.remove();
  }
}

function downloadBlobFile(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setPayslipImageButtonsBusy(busy) {
  ['btn-save-png', 'btn-share-line'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.disabled = busy; b.classList.toggle('opacity-60', busy); }
  });
}

function render50Tawi(empId, year) {
  const docObj = TAWI_DOC[tawiDocLang] || TAWI_DOC.th || {};
  const isThOnly = tawiDocLang !== 'thEn';

  const btnTh = document.getElementById('btn-tawi-th');
  const btnThEn = document.getElementById('btn-tawi-then');
  if (btnTh && btnThEn) {
    btnTh.className = `px-3 py-1 rounded-lg transition ${isThOnly ? 'bg-white text-wood-700 shadow-sm font-extrabold' : 'text-stone-600'}`;
    btnThEn.className = `px-3 py-1 rounded-lg transition ${!isThOnly ? 'bg-white text-wood-700 shadow-sm font-extrabold' : 'text-stone-600'}`;
  }

  const summary = computeAnnualTaxSummary(year);
  const empIdx = summary.items.findIndex(x => x.empId === empId);
  const it = empIdx >= 0 ? summary.items[empIdx] : null;
  if (!it) return;

  const emp = it.emp;
  const yearBe = Number(year) + 543;
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0'), mm = String(now.getMonth() + 1).padStart(2, '0'), yyyy = now.getFullYear(), yyyyBe = yyyy + 543;
  const issueDateStr = isThOnly ? `${dd}/${mm}/${yyyyBe}` : `${yyyy}-${mm}-${dd} (B.E. ${yyyyBe})`;
  const docNoStr = `50TW-${year}-${String(empIdx + 1).padStart(3, '0')}`;

  const rawStore = (state.settings.storeName || '').trim();
  const tawiStoreName = (!rawStore || rawStore === '매장 인사·급여 관리') ? 'MISO Bakery' : rawStore;
  const subtitleText = String(docObj.subtitle || '').replaceAll('{year}', String(year)).replaceAll('{yearBe}', String(yearBe));
  const hireDisplay = emp.hireDate ? `${emp.hireDate}${emp.resignDate ? ` - ${emp.resignDate}` : ''}` : (emp.resignDate || '-');

  document.getElementById('payslip-print-area').innerHTML = `
    <div class="space-y-3 text-warm-900">
      <div class="border-b-2 border-warm-900 pb-3 flex items-start justify-between gap-4">
        <div>
          <p class="text-[10px] text-stone-500 font-medium">${escapeHtml(docObj.copyLabel || '')}</p>
          <h3 class="text-lg sm:text-xl font-extrabold text-warm-900 mt-1">${escapeHtml(docObj.title || '')}</h3>
          <p class="text-xs font-semibold text-wood-700 mt-0.5">${escapeHtml(subtitleText)}</p>
        </div>
        <div class="text-right text-[11px] text-stone-600 shrink-0 space-y-0.5">
          <div><span class="font-bold">${escapeHtml(docObj.docNo || '')}:</span> <span class="font-mono font-bold text-warm-900">${escapeHtml(docNoStr)}</span></div>
          <div><span class="font-bold">${escapeHtml(docObj.issueDate || '')}:</span> <span class="font-mono font-bold text-warm-900">${escapeHtml(issueDateStr)}</span></div>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div class="bg-warm-50 border border-warm-300 rounded-xl p-3 space-y-1">
          <div class="font-extrabold text-wood-700">${escapeHtml(docObj.payerTitle || '')}</div>
          <div class="font-extrabold text-sm text-warm-900">${escapeHtml(tawiStoreName)}</div>
          <div class="font-mono text-stone-700"><span class="font-semibold">${escapeHtml(docObj.taxId || '')}:</span> ${escapeHtml(state.settings.storeTaxId || '-')}</div>
          <div class="text-stone-700"><span class="font-semibold">${escapeHtml(docObj.address || '')}:</span> ${escapeHtml(state.settings.storeAddress || 'Chiang Rai, Thailand')}</div>
        </div>
        <div class="bg-warm-50 border border-warm-300 rounded-xl p-3 space-y-1">
          <div class="font-extrabold text-wood-700">${escapeHtml(docObj.payeeTitle || '')}</div>
          <div class="font-extrabold text-sm text-warm-900">${escapeHtml(emp.name)}</div>
          <div class="font-mono text-stone-700"><span class="font-semibold">${escapeHtml(docObj.taxId || '')}:</span> ${escapeHtml(emp.idNumber || '-')}</div>
          <div class="font-mono text-stone-700"><span class="font-semibold">${escapeHtml(docObj.hireDate || '')}:</span> ${escapeHtml(hireDisplay)}</div>
        </div>
      </div>

      <div class="border border-warm-300 rounded-xl p-3 bg-white text-xs space-y-1">
        <div class="font-extrabold text-warm-900">${escapeHtml(docObj.incomeTypeTitle || '')}</div>
        <div class="flex flex-wrap items-center justify-between gap-2 text-warm-800">
          <span class="font-semibold">☑ ${escapeHtml(docObj.income401 || '')}</span>
          <span class="font-bold text-wood-700">${escapeHtml(docObj.withholdType || '')}</span>
        </div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        <div class="border border-warm-300 bg-white rounded-xl p-3"><span class="text-stone-500 block text-[11px]">${escapeHtml(docObj.sumGross || '')}</span><strong class="font-mono text-sm text-warm-900">${formatMoney(it.gross)}</strong></div>
        <div class="border border-warm-300 bg-white rounded-xl p-3"><span class="text-stone-500 block text-[11px]">${escapeHtml(docObj.sumWht || '')}</span><strong class="font-mono text-sm text-indigo-800">${formatMoney(it.wht)}</strong></div>
        <div class="border border-warm-300 bg-white rounded-xl p-3"><span class="text-stone-500 block text-[11px]">${escapeHtml(docObj.sumEmpSso || '')}</span><strong class="font-mono text-sm text-stone-800">${formatMoney(it.empSso)}</strong></div>
        <div class="border border-warm-300 bg-white rounded-xl p-3"><span class="text-stone-500 block text-[11px]">${escapeHtml(docObj.sumErSso || '')}</span><strong class="font-mono text-sm text-sky-900">${formatMoney(it.erSso)}</strong></div>
        <div class="border-2 border-warm-800 bg-warm-50 text-warm-900 rounded-xl p-3 col-span-2 sm:col-span-1"><span class="text-wood-700 font-bold block text-[11px]">${escapeHtml(docObj.sumNet || '')}</span><strong class="font-mono text-sm font-extrabold text-warm-900">${formatMoney(it.net)}</strong></div>
      </div>

      <div class="overflow-x-auto rounded-xl border border-warm-300">
        <table class="w-full text-left border-collapse text-[11px]">
          <thead>
            <tr class="bg-warm-100 text-warm-900 border-b border-warm-300">
              <th class="py-1.5 px-2.5 font-extrabold">${escapeHtml(docObj.colMonth || '')}</th>
              <th class="py-1.5 px-2.5 font-extrabold">${escapeHtml(docObj.colStatus || '')}</th>
              <th class="py-1.5 px-2.5 font-extrabold text-right">${escapeHtml(docObj.colGross || '')}</th>
              <th class="py-1.5 px-2.5 font-extrabold text-right">${escapeHtml(docObj.colWht || '')}</th>
              <th class="py-1.5 px-2.5 font-extrabold text-right">${escapeHtml(docObj.colSso || '')}</th>
              <th class="py-1.5 px-2.5 font-extrabold text-right">${escapeHtml(docObj.colNet || '')}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-warm-200 bg-white">
            ${it.months.map(m => `
              <tr>
                <td class="py-1.5 px-2.5 font-mono font-bold">${escapeHtml(m.ym)}</td>
                <td class="py-1.5 px-2.5">${escapeHtml(m.isClosed ? (docObj.statusClosed || '') : (docObj.statusOpen || ''))}</td>
                <td class="py-1.5 px-2.5 text-right font-mono">${formatMoney(m.gross)}</td>
                <td class="py-1.5 px-2.5 text-right font-mono text-indigo-800">${formatMoney(m.wht)}</td>
                <td class="py-1.5 px-2.5 text-right font-mono">${formatMoney(m.empSso)}</td>
                <td class="py-1.5 px-2.5 text-right font-mono font-bold">${formatMoney(m.net)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="border-t border-warm-300 pt-3 flex flex-col sm:flex-row sm:items-end justify-between gap-4 text-xs">
        <p class="text-[11px] text-stone-700 font-medium">${escapeHtml(docObj.certifyText || '')}</p>
        <div class="flex items-center justify-end gap-4 shrink-0">
          <div class="text-center space-y-1">
            <div class="pt-4 font-mono text-stone-500">...........................................</div>
            <div class="font-bold text-warm-900">${escapeHtml(docObj.signPayer || '')}</div>
          </div>
          <div class="w-16 h-16 rounded-full border-2 border-dashed border-stone-400 flex items-center justify-center text-center text-[10px] text-stone-500 font-semibold p-1 leading-tight">
            ${escapeHtml(docObj.stampLabel || '')}
          </div>
        </div>
      </div>
    </div>`;
}

function renderLogsTab() {
  const today = getTodayStr(), activeEmps = state.employees.filter(e => e.active !== false), todayLogs = state.attendance.filter(l => l.date === today);
  const lateCnt = todayLogs.filter(l => analyzeAttendance(l, state.employees.find(e => e.id === l.empId)).lateMins > 0).length;
  const lvCnt = state.leaves.filter(lv => lv.date === today && lv.status === 'APPROVED').length, up = t('unitPerson');
  const kpiEl = document.getElementById('today-kpi-grid');
  if (kpiEl) {
    kpiEl.innerHTML = `
      <div class="bg-white rounded-2xl border border-warm-200 p-4 shadow-sm"><span class="text-xs font-semibold text-stone-500">${escapeHtml(t('kpiTodayIn'))}</span><p class="text-2xl font-extrabold text-emerald-700 mt-1">${todayLogs.length}${up ? `<span class="text-sm font-semibold text-stone-400 ml-1">${escapeHtml(up)}</span>` : ''}</p></div>
      <div class="bg-white rounded-2xl border border-warm-200 p-4 shadow-sm"><span class="text-xs font-semibold text-stone-500">${escapeHtml(t('kpiTodayLate'))}</span><p class="text-2xl font-extrabold ${lateCnt > 0 ? 'text-rose-600' : 'text-warm-900'} mt-1">${lateCnt}${up ? `<span class="text-sm font-semibold text-stone-400 ml-1">${escapeHtml(up)}</span>` : ''}</p></div>
      <div class="bg-white rounded-2xl border border-warm-200 p-4 shadow-sm"><span class="text-xs font-semibold text-stone-500">${escapeHtml(t('kpiTodayLeave'))}</span><p class="text-2xl font-extrabold text-wood-600 mt-1">${lvCnt}${up ? `<span class="text-sm font-semibold text-stone-400 ml-1">${escapeHtml(up)}</span>` : ''}</p></div>
      <div class="bg-white rounded-2xl border border-warm-200 p-4 shadow-sm"><span class="text-xs font-semibold text-stone-500">${escapeHtml(t('kpiTotalEmp'))}</span><p class="text-2xl font-extrabold text-warm-900 mt-1">${activeEmps.length}${up ? `<span class="text-sm font-semibold text-stone-400 ml-1">${escapeHtml(up)}</span>` : ''}</p></div>`;
  }
  const mEl = document.getElementById('filter-log-month'); if (!mEl) return;
  if (!mEl.value) mEl.value = getCurrentMonthStr();
  const tm = mEl.value, td = document.getElementById('filter-log-date').value, eEl = document.getElementById('filter-log-emp'), prev = eEl.value || 'ALL';
  eEl.innerHTML = `<option value="ALL">${escapeHtml(t('allEmployees'))}</option>` + state.employees.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
  eEl.value = state.employees.some(e => e.id === prev) ? prev : 'ALL';
  const flt = state.attendance.filter(l => (td ? l.date === td : (!tm || (l.date || '').startsWith(tm))) && (eEl.value === 'ALL' || l.empId === eEl.value));
  let sH = 0, sO = 0, sHl = 0, lC = 0;
  flt.forEach(l => { const a = analyzeAttendance(l, state.employees.find(e => e.id === l.empId)); sH += a.workedHours; sO += a.otHours; sHl += a.holidayHours; if (a.lateMins > 0) lC++; });
  document.getElementById('logs-period-stats').innerHTML = `<span class="px-3 py-1 rounded-xl bg-warm-100 text-warm-900 font-bold">${escapeHtml(t('statCount', { n: flt.length }))}</span><span class="px-3 py-1 rounded-xl bg-warm-100 text-warm-900 font-bold">${escapeHtml(t('statTotalHours', { h: sH.toFixed(1) }))}</span><span class="px-3 py-1 rounded-xl bg-amber-50 text-wood-700 font-bold">${escapeHtml(t('statOtHol', { ot: sO.toFixed(1), hol: sHl.toFixed(1) }))}</span><span class="px-3 py-1 rounded-xl ${lC > 0 ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'} font-bold">${escapeHtml(t('statLate', { n: lC }))}</span>`;
  const tb = document.getElementById('logs-tbody');
  if (flt.length === 0) { tb.innerHTML = `<tr><td colspan="7" class="py-10 text-center text-stone-400 text-xs">${escapeHtml(t('logsEmpty'))}</td></tr>`; return; }
  tb.innerHTML = flt.map(l => {
    const emp = state.employees.find(e => e.id === l.empId), a = analyzeAttendance(l, emp);
    let bg = `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">${escapeHtml(t('badgeNormal'))}</span>`;
    if (!l.clockOut) bg = `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-sky-100 text-sky-800">${escapeHtml(t('badgeWorking'))}</span>`;
    else if (a.lateMins > 0) bg = `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-rose-100 text-rose-800">${escapeHtml(t('badgeLate', { m: a.lateMins }))}</span>`;
    const shiftBadge = (a.fromSchedule && a.shiftName)
      ? `<span class="inline-block ml-1.5 px-1.5 py-0.5 rounded border text-[10px] font-bold align-middle ${getShiftColorClasses(a.shiftColor)}">${escapeHtml(a.shiftName)}</span>`
      : '';
    return `<tr class="hover:bg-warm-50/80 transition">
      <td class="py-3 px-4 font-mono text-xs font-bold text-warm-800">${escapeHtml(l.date)}${a.isHolidayWork ? `<span class="ml-1 px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px]">${escapeHtml(t('badgeHoliday'))}</span>` : ''}</td>
      <td class="py-3 px-4"><div class="font-bold text-warm-900">${escapeHtml(emp ? emp.name : t('deletedEmp'))}${shiftBadge}</div>${l.note ? `<div class="text-[11px] text-stone-400">${escapeHtml(l.note)}</div>` : ''}</td>
      <td class="py-3 px-4 font-mono text-xs"><span class="text-emerald-700 font-bold">${escapeHtml(l.clockIn || '-')}</span><span class="text-stone-400 mx-1">→</span><span class="text-rose-700 font-bold">${escapeHtml(l.clockOut || t('notClockedOut'))}</span></td>
      <td class="py-3 px-4 text-xs"><span class="font-bold text-warm-900">${a.workedHours}h</span>${a.otHours > 0 ? `<span class="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-wood-700 font-bold">${escapeHtml(t('tagOt', { h: a.otHours }))}</span>` : ''}${a.holidayHours > 0 ? `<span class="ml-1 px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-bold">${escapeHtml(t('tagHol', { h: a.holidayHours }))}</span>` : ''}</td>
      <td class="py-3 px-4">${bg}</td>
      <td class="py-3 px-4"><div class="flex items-center gap-1.5">${l.inPhoto ? `<img src="${l.inPhoto}" onclick="HR.openSelfieModal('${l.id}')" alt="IN" class="w-11 h-8 object-cover rounded-lg border border-warm-300 cursor-pointer hover:scale-110 transition" />` : '<span class="text-xs text-stone-400">-</span>'}${l.outPhoto ? `<img src="${l.outPhoto}" onclick="HR.openSelfieModal('${l.id}')" alt="OUT" class="w-11 h-8 object-cover rounded-lg border border-warm-300 cursor-pointer hover:scale-110 transition" />` : ''}</div></td>
      <td class="py-3 px-4 text-right space-x-1 whitespace-nowrap"><button type="button" onclick="HR.openLogModal('${l.id}')" class="px-2.5 py-1 rounded-lg border border-warm-300 hover:bg-warm-100 text-xs font-bold text-warm-800">${escapeHtml(t('btnEdit'))}</button><button type="button" onclick="HR.confirmDeleteLog('${l.id}')" class="px-2.5 py-1 rounded-lg border border-rose-200 hover:bg-rose-50 text-xs font-bold text-rose-600">${escapeHtml(t('btnDelete'))}</button></td>
    </tr>`;
  }).join('');
}

function renderShiftsTab() {
  const tplListEl = document.getElementById('shift-templates-list');
  const rangeEl = document.getElementById('shift-week-range-label');
  const theadEl = document.getElementById('shift-roster-thead');
  const tbodyEl = document.getElementById('shift-roster-tbody');
  if (!tplListEl || !theadEl || !tbodyEl) return;

  const templates = getShiftTemplates();
  tplListEl.innerHTML = templates.length === 0
    ? `<div class="col-span-full py-6 text-center text-xs text-stone-400">${escapeHtml(t('shiftTplEmpty'))}</div>`
    : templates.map(tpl => `
      <div class="rounded-2xl border p-3.5 flex flex-col justify-between gap-2.5 ${getShiftColorClasses(tpl.color)}">
        <div>
          <div class="font-extrabold text-sm truncate">${escapeHtml(tpl.name)}</div>
          <div class="font-mono text-xs font-bold mt-1 opacity-90">${escapeHtml(tpl.start)} ~ ${escapeHtml(tpl.end)}</div>
          <div class="text-[11px] opacity-75 mt-0.5">${escapeHtml(t('empFBreak'))}: ${Number(tpl.breakMinutes ?? 60)}${escapeHtml(t('unitMin'))}</div>
        </div>
        <div class="flex justify-end gap-1.5 pt-2 border-t border-black/10">
          <button type="button" onclick="HR.openShiftTemplateModal('${tpl.id}')" class="px-2.5 py-1 rounded-lg bg-white/80 hover:bg-white text-warm-900 text-[11px] font-bold border border-black/10 transition">${escapeHtml(t('btnEdit'))}</button>
          <button type="button" onclick="HR.confirmDeleteShiftTemplate('${tpl.id}')" class="px-2.5 py-1 rounded-lg bg-white/80 hover:bg-rose-50 text-rose-700 text-[11px] font-bold border border-rose-200 transition">${escapeHtml(t('btnDelete'))}</button>
        </div>
      </div>`).join('');

  const dates = getWeekDates(shiftWeekStartStr);
  const today = getTodayStr();
  const daysShort = t('daysShort');
  if (rangeEl) rangeEl.textContent = `${dates[0]} ~ ${dates[6]}`;

  theadEl.innerHTML = `<tr class="bg-warm-100 text-warm-800 text-xs border-b border-warm-200">
    <th class="py-3 px-4 font-extrabold min-w-[140px]">${escapeHtml(t('thEmployee'))}</th>
    ${dates.map(dateStr => {
      const dow = new Date(dateStr + 'T00:00:00').getDay();
      const isToday = dateStr === today;
      const hol = state.holidays.find(h => h.date === dateStr);
      const isStoreOff = (state.settings.weeklyOffDays || []).includes(dow);
      const mmdd = dateStr.slice(5).replace('-', '/');
      return `<th class="py-2.5 px-2 text-center font-extrabold min-w-[112px] ${isToday ? 'bg-amber-100/90 text-wood-700' : ''}">
        <div class="font-mono">${mmdd} (${escapeHtml(daysShort[dow])})</div>
        ${hol ? `<span class="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] font-bold truncate max-w-[100px]" title="${escapeHtml(hol.name)}">${escapeHtml(t('badgeHoliday'))}</span>` : (isStoreOff ? `<span class="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-stone-200 text-stone-600 text-[10px] font-bold">${escapeHtml(t('dayStatusOff'))}</span>` : '')}
      </th>`;
    }).join('')}
  </tr>`;

  const activeEmps = state.employees.filter(e => e.active !== false);
  const leaveTypeMap = { ANNUAL: t('leaveTypeAnnual'), SICK: t('leaveTypeSick'), UNPAID: t('leaveTypeUnpaid'), ABSENT: t('leaveTypeAbsent') };

  if (activeEmps.length === 0) {
    tbodyEl.innerHTML = `<tr><td colspan="8" class="py-10 text-center text-stone-400 text-xs">${escapeHtml(t('empEmpty'))}</td></tr>`;
    return;
  }

  tbodyEl.innerHTML = activeEmps.map(emp => `
    <tr class="hover:bg-warm-50/50">
      <td class="py-3 px-4 align-middle">
        <div class="font-bold text-warm-900 text-xs sm:text-sm">${escapeHtml(emp.name)}</div>
        <div class="text-[11px] text-stone-500">${escapeHtml(emp.role)}</div>
        <div class="text-[10px] font-mono text-stone-400 mt-0.5">${escapeHtml(emp.shiftStart || '09:00')}~${escapeHtml(emp.shiftEnd || '18:00')}</div>
      </td>
      ${dates.map(dateStr => {
        const isToday = dateStr === today;
        const sched = state.schedules[`${dateStr}_${emp.id}`];
        const lv = state.leaves.find(x => x.empId === emp.id && x.date === dateStr && x.status === 'APPROVED');
        const lvBadge = lv
          ? `<div class="mt-1 px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 text-[10px] font-bold truncate">${escapeHtml(leaveTypeMap[lv.type] || lv.type)}</div>`
          : '';
        let inner = '';
        if (sched && sched.isOff) {
          inner = `<div class="rounded-xl border px-2 py-2 text-center ${getShiftColorClasses('rose')} hover:brightness-95 transition">
            <div class="text-[11px] font-extrabold">${escapeHtml(t('shiftOffBadge'))}</div>
            ${lvBadge}
          </div>`;
        } else if (sched) {
          inner = `<div class="rounded-xl border px-2 py-2 text-center ${getShiftColorClasses(sched.color)} hover:brightness-95 transition">
            <div class="text-[11px] font-extrabold truncate">${escapeHtml(sched.shiftName)}</div>
            <div class="text-[10px] font-mono font-semibold opacity-90 mt-0.5">${escapeHtml(sched.start)}~${escapeHtml(sched.end)}</div>
            ${lvBadge}
          </div>`;
        } else {
          inner = `<div class="rounded-xl border border-dashed border-warm-300 bg-warm-50/70 hover:bg-warm-100 px-2 py-2 text-center text-stone-500 transition">
            <div class="text-[10px] font-bold text-stone-400">${escapeHtml(t('shiftDefaultBadge'))}</div>
            <div class="text-[10px] font-mono mt-0.5">${escapeHtml(emp.shiftStart || '09:00')}~${escapeHtml(emp.shiftEnd || '18:00')}</div>
            ${lvBadge}
          </div>`;
        }
        return `<td class="p-1.5 align-middle ${isToday ? 'bg-amber-50/50' : ''}"><button type="button" onclick="HR.openShiftAssignModal('${emp.id}', '${dateStr}')" class="w-full text-left block focus:outline-none">${inner}</button></td>`;
      }).join('')}
    </tr>`).join('');
}

function renderPayrollTab() {
  const mEl = document.getElementById('payroll-month-input'); if (!mEl) return;
  if (!mEl.value) mEl.value = getCurrentMonthStr();
  const tm = mEl.value;
  document.getElementById('rule-ot-mult').value = state.settings.otMultiplier ?? 1.5;
  document.getElementById('rule-hol-mult').value = state.settings.holidayOtMultiplier ?? 2.0;
  document.getElementById('rule-late-grace').value = state.settings.lateGraceMinutes ?? 10;
  document.getElementById('rule-late-enabled').checked = state.settings.lateDeductionEnabled !== false;
  document.getElementById('rule-sso-enabled').checked = state.settings.ssoEnabled !== false;
  document.getElementById('rule-work-days').value = String(state.settings.standardWorkDays || 26);
  document.getElementById('rule-sso-rate').value = state.settings.ssoRateThb ?? 5;
  document.getElementById('rule-sso-cap').value = state.settings.ssoCapThb ?? 875;
  const attEnEl = document.getElementById('rule-att-bonus-enabled');
  const attAmtEl = document.getElementById('rule-att-bonus-amount');
  const proEnEl = document.getElementById('rule-prorata-enabled');
  if (attEnEl) attEnEl.checked = state.settings.attendanceBonusEnabled === true;
  if (attAmtEl && document.activeElement !== attAmtEl) attAmtEl.value = state.settings.attendanceBonusAmount ?? 1000;
  if (proEnEl) proEnEl.checked = state.settings.prorataEnabled !== false;

  const view = getPayrollViewData(tm), rows = view.rows;
  const closeBtn = document.getElementById('btn-close-payroll'), banner = document.getElementById('payroll-closure-banner');
  if (view.isClosed) {
    closeBtn.classList.add('hidden');
    banner.classList.remove('hidden');
    document.getElementById('closure-badge-text').textContent = t('badgePayrollClosed', { date: view.closure.closedDate || '' });
    document.getElementById('closure-transfer-text').textContent = t('transferSummary', { done: rows.filter(r => r.transferPaid).length, total: rows.length });
  } else {
    closeBtn.classList.remove('hidden');
    banner.classList.add('hidden');
  }

  const sumEmployerCost = rows.reduce((s, r) => s + r.employerTotalCost, 0);
  const sumTotalSso = rows.reduce((s, r) => s + r.ssoDeduction + r.employerSso, 0);
  const sumWht = rows.reduce((s, r) => s + r.whtDeduction, 0);
  const sumNet = rows.reduce((s, r) => s + r.netPay, 0);

  document.getElementById('payroll-kpi-grid').innerHTML = `
    <div class="bg-warm-50 border border-warm-200 rounded-2xl p-4"><span class="text-xs text-stone-500">${escapeHtml(t('kpiPayEmployerCost'))}</span><p class="text-xl font-extrabold text-warm-900 mt-1">${formatMoney(sumEmployerCost)}</p></div>
    <div class="bg-warm-50 border border-warm-200 rounded-2xl p-4"><span class="text-xs text-stone-500">${escapeHtml(t('kpiPayTotalSso'))}</span><p class="text-xl font-extrabold text-sky-800 mt-1">${formatMoney(sumTotalSso)}</p></div>
    <div class="bg-warm-50 border border-warm-200 rounded-2xl p-4"><span class="text-xs text-stone-500">${escapeHtml(t('kpiPayTotalWht'))}</span><p class="text-xl font-extrabold text-indigo-800 mt-1">${formatMoney(sumWht)}</p></div>
    <div class="bg-wood-600 text-white rounded-2xl p-4 shadow-sm"><span class="text-xs text-amber-100">${escapeHtml(t('kpiPayNet'))}</span><p class="text-xl font-extrabold mt-1">${formatMoney(sumNet)}</p></div>`;

  const tb = document.getElementById('payroll-tbody');
  if (rows.length === 0) { tb.innerHTML = `<tr><td colspan="9" class="py-10 text-center text-stone-400 text-xs">${escapeHtml(t('payrollEmpty'))}</td></tr>`; return; }
  tb.innerHTML = rows.map(r => {
    const eid = r.empId || r.emp.id;
    const baseSubBadge = r.isNotEmployed
      ? `<div class="text-[10px] font-sans font-bold text-stone-400 mt-0.5">${escapeHtml(t('badgeNotEmployed'))}</div>`
      : (r.isProrated ? `<div class="text-[10px] font-sans font-bold text-amber-700 mt-0.5">${escapeHtml(t('badgeProrata', { d: r.prorataEmployedDays, t: r.prorataTotalDays }))}</div>` : '');
    const plusTotal = r.otPay + r.holidayPay + (r.attendanceBonus || 0) + r.extraBonus;
    const attBonusSub = (r.attendanceBonus || 0) > 0
      ? `<div class="text-[10px] font-sans font-bold text-emerald-700 mt-0.5">${escapeHtml(t('badgeAttBonus', { amt: formatMoney(r.attendanceBonus) }))}</div>`
      : '';
    const actionBtns = view.isClosed
      ? `<button type="button" onclick="HR.toggleTransferPaid('${tm}','${eid}')" class="px-2.5 py-1.5 rounded-xl text-xs font-bold border transition ${r.transferPaid ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-amber-50 text-wood-700 border-amber-300 hover:bg-amber-100'}">${escapeHtml(r.transferPaid ? t('btnTransferPaid') : t('btnTransferUnpaid'))}</button>
         <button type="button" disabled class="px-2 py-1.5 rounded-xl border border-stone-200 bg-stone-100 text-stone-400 text-xs font-bold cursor-not-allowed">${escapeHtml(t('btnAdjust'))}</button>
         <button type="button" onclick="HR.openPayslipModal('${eid}')" class="px-3 py-1.5 rounded-xl bg-warm-900 hover:bg-black text-white text-xs font-bold">${escapeHtml(t('btnPayslip'))}</button>`
      : `<button type="button" onclick="HR.openAdjModal('${eid}')" class="px-2.5 py-1.5 rounded-xl border border-warm-300 bg-white hover:bg-warm-100 text-xs font-bold text-warm-800">${escapeHtml(t('btnAdjust'))}</button>
         <button type="button" onclick="HR.openPayslipModal('${eid}')" class="px-3 py-1.5 rounded-xl bg-warm-900 hover:bg-black text-white text-xs font-bold">${escapeHtml(t('btnPayslip'))}</button>`;
    return `<tr class="hover:bg-warm-50/80 transition">
      <td class="py-3.5 px-4"><div class="font-bold text-warm-900">${escapeHtml(r.emp.name)}</div><div class="text-xs text-stone-500">${escapeHtml(r.emp.role)} · <span class="font-bold text-wood-600">${escapeHtml(r.emp.payType === 'MONTHLY' ? t('payTypeMonthly') : t('payTypeHourly'))}</span></div></td>
      <td class="py-3.5 px-4 text-xs"><div class="font-bold text-warm-900">${escapeHtml(t('payWorkSummary', { d: r.workDaysCount, h: r.totalWorkedHours }))}</div><div class="text-stone-500">${escapeHtml(t('payOtUnpaidSummary', { ot: r.totalOtHours, hol: r.totalHolidayHours, u: r.unpaidLeaveDays }))}</div></td>
      <td class="py-3.5 px-4 text-right font-mono font-bold text-warm-900">${formatMoney(r.basePay)}${baseSubBadge}</td>
      <td class="py-3.5 px-4 text-right font-mono text-xs text-emerald-700 font-bold">+${formatMoney(plusTotal)}${attBonusSub}</td>
      <td class="py-3.5 px-4 text-right font-mono text-xs text-rose-600 font-bold">-${formatMoney(r.lateDeduction + r.unpaidDeduction + r.extraDeduction)}</td>
      <td class="py-3.5 px-4 text-right font-mono text-xs text-stone-600">-${formatMoney(r.ssoDeduction)}</td>
      <td class="py-3.5 px-4 text-right font-mono text-xs text-indigo-700 font-bold">-${formatMoney(r.whtDeduction)}</td>
      <td class="py-3.5 px-4 text-right font-mono font-extrabold text-base text-wood-700">${formatMoney(r.netPay)}</td>
      <td class="py-3.5 px-4 text-center whitespace-nowrap space-x-1">${actionBtns}</td>
    </tr>`;
  }).join('');
}

function renderLeavesTab() {
  const yearSel = document.getElementById('leave-balance-year'), curYearNum = Number(getTodayStr().slice(0, 4));
  if (yearSel) {
    const prevVal = yearSel.value || String(curYearNum), yearOpts = [];
    for (let y = curYearNum + 2; y >= curYearNum - 2; y--) yearOpts.push(String(y));
    yearSel.innerHTML = yearOpts.map(y => `<option value="${y}">${y}</option>`).join('');
    yearSel.value = yearOpts.includes(prevVal) ? prevVal : String(curYearNum);
  }
  const targetYear = yearSel ? yearSel.value : String(curYearNum), lbTitle = document.getElementById('leave-balance-title');
  if (lbTitle) lbTitle.textContent = t('leaveBalanceTitle', { year: targetYear });

  const activeEmps = state.employees.filter(e => e.active !== false), lbBody = document.getElementById('leave-balance-tbody'), unitD = t('unitDay');
  if (lbBody) {
    lbBody.innerHTML = activeEmps.length === 0
      ? `<tr><td colspan="5" class="py-8 text-center text-stone-400 text-xs">${escapeHtml(t('empEmpty'))}</td></tr>`
      : activeEmps.map(emp => {
          const st = getEmployeeLeaveStats(emp, targetYear);
          const remBadge = st.remaining > 0 ? `<span class="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-emerald-100 text-emerald-800">${st.remaining}${escapeHtml(unitD)}</span>` : `<span class="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-rose-100 text-rose-800">${st.remaining}${escapeHtml(unitD)}</span>`;
          return `<tr class="hover:bg-warm-50"><td class="py-3 px-4"><span class="font-bold text-warm-900">${escapeHtml(emp.name)}</span> <span class="text-xs text-stone-500">· ${escapeHtml(emp.role)}</span></td><td class="py-3 px-4 text-right font-mono font-bold text-warm-900">${st.quota}${escapeHtml(unitD)}</td><td class="py-3 px-4 text-right font-mono text-stone-700">${st.used}${escapeHtml(unitD)}</td><td class="py-3 px-4 text-center">${remBadge}</td><td class="py-3 px-4 text-right font-mono text-stone-600">${st.sickUsed}${escapeHtml(unitD)}</td></tr>`;
        }).join('');
  }

  const wGrid = document.getElementById('weekly-off-grid');
  if (wGrid) {
    wGrid.innerHTML = t('daysShort').map((d, i) => {
      const o = (state.settings.weeklyOffDays || []).includes(i);
      return `<button type="button" onclick="HR.toggleWeeklyOff(${i})" class="py-2.5 rounded-xl text-xs font-extrabold border transition ${o ? 'bg-rose-600 text-white border-rose-600 shadow-sm' : 'bg-warm-50 text-warm-800 border-warm-200 hover:bg-warm-100'}">${escapeHtml(d)}<span class="block text-[10px] font-medium mt-0.5">${escapeHtml(o ? t('dayStatusOff') : t('dayStatusWork'))}</span></button>`;
    }).join('');
  }
  const hl = document.getElementById('holidays-list');
  if (hl) {
    hl.innerHTML = state.holidays.length === 0 ? `<p class="text-xs text-stone-400 text-center py-4">${escapeHtml(t('holEmpty'))}</p>` : state.holidays.map(h => `<div class="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-warm-50 border border-warm-200 text-xs"><div><span class="font-mono font-bold text-wood-700 mr-2">${escapeHtml(h.date)}</span><span class="font-bold text-warm-900">${escapeHtml(h.name)}</span></div><button type="button" onclick="HR.deleteHoliday('${h.id}')" class="text-rose-600 hover:text-rose-800 font-bold px-1.5">✕</button></div>`).join('');
  }
  const tm = { ANNUAL: t('leaveTypeAnnual'), SICK: t('leaveTypeSick'), UNPAID: t('leaveTypeUnpaid'), ABSENT: t('leaveTypeAbsent') };
  const sm = { APPROVED: `<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">${escapeHtml(t('leaveStatusApproved'))}</span>`, PENDING: `<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800">${escapeHtml(t('leaveStatusPending'))}</span>`, REJECTED: `<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-stone-200 text-stone-600">${escapeHtml(t('leaveStatusRejected'))}</span>` };
  const tb = document.getElementById('leaves-tbody');
  if (tb) {
    tb.innerHTML = state.leaves.length === 0 ? `<tr><td colspan="6" class="py-10 text-center text-stone-400 text-xs">${escapeHtml(t('leavesEmpty'))}</td></tr>` : state.leaves.map(lv => {
      const emp = state.employees.find(e => e.id === lv.empId);
      return `<tr class="hover:bg-warm-50"><td class="py-3 px-4 font-bold text-warm-900">${escapeHtml(emp ? emp.name : t('deletedEmp'))}</td><td class="py-3 px-4 text-xs"><div class="font-bold text-warm-900">${escapeHtml(tm[lv.type] || lv.type)}</div><div class="text-stone-400">${escapeHtml(lv.reason || '')}</div></td><td class="py-3 px-4 font-mono text-xs font-semibold">${escapeHtml(lv.date)}</td><td class="py-3 px-4"><span class="px-2 py-0.5 rounded text-xs font-bold ${lv.isPaid ? 'bg-sky-50 text-sky-700' : 'bg-rose-50 text-rose-700'}">${escapeHtml(lv.isPaid ? t('leavePaidShort') : t('leaveUnpaidShort'))}</span></td><td class="py-3 px-4">${sm[lv.status] || ''}</td><td class="py-3 px-4 text-right whitespace-nowrap space-x-1">${lv.status !== 'APPROVED' ? `<button type="button" onclick="HR.setLeaveStatus('${lv.id}','APPROVED')" class="px-2 py-1 rounded-lg bg-emerald-600 text-white text-xs font-bold">${escapeHtml(t('btnApprove'))}</button>` : ''}${lv.status === 'PENDING' ? `<button type="button" onclick="HR.setLeaveStatus('${lv.id}','REJECTED')" class="px-2 py-1 rounded-lg bg-stone-500 text-white text-xs font-bold">${escapeHtml(t('btnReject'))}</button>` : ''}<button type="button" onclick="HR.deleteLeave('${lv.id}')" class="px-2 py-1 rounded-lg border border-warm-300 text-xs text-stone-500 hover:text-rose-600 font-bold">${escapeHtml(t('btnDelete'))}</button></td></tr>`;
    }).join('');
  }
}

function renderEmployeesTab() {
  const grid = document.getElementById('employees-grid'); if (!grid) return;
  if (state.employees.length === 0) { grid.innerHTML = `<div class="col-span-full py-12 text-center text-stone-400 text-sm">${escapeHtml(t('empEmpty'))}</div>`; return; }
  const dl = t('daysFull'), curYear = getTodayStr().slice(0, 4), unitD = t('unitDay');
  grid.innerHTML = state.employees.map(emp => {
    const act = emp.active !== false, off = (typeof emp.weeklyDayOff === 'number' && emp.weeklyDayOff >= 0) ? dl[emp.weeklyDayOff] : t('optStoreRule');
    const attBonusElig = emp.attendanceBonusEligible !== undefined ? !!emp.attendanceBonusEligible : (emp.payType === 'MONTHLY');
    const hireStr = emp.hireDate ? `${emp.hireDate}${emp.resignDate ? ` (${t('empCardResign')} ${emp.resignDate})` : ''}` : (emp.resignDate ? `${t('empCardResign')} ${emp.resignDate}` : '');
    const bankStr = (emp.bankName || emp.bankAccount) ? `${emp.bankName || ''} ${emp.bankAccount || ''}`.trim() : '';
    const lStats = getEmployeeLeaveStats(emp, curYear);
    return `<div class="rounded-2xl border p-5 flex flex-col justify-between space-y-4 transition ${act ? 'bg-warm-50/70 border-warm-200 hover:shadow-md' : 'bg-stone-100/80 border-stone-200 opacity-75'}">
      <div class="space-y-3">
        <div class="flex items-start justify-between gap-2"><div><div class="flex items-center gap-1.5"><span class="px-2 py-0.5 rounded-md text-[11px] font-bold ${emp.payType === 'MONTHLY' ? 'bg-amber-100 text-wood-700' : 'bg-sky-100 text-sky-800'}">${escapeHtml(emp.payType === 'MONTHLY' ? t('payTypeMonthly') : t('payTypeHourly'))}</span>${!act ? `<span class="px-2 py-0.5 rounded-md text-[11px] font-bold bg-stone-300 text-stone-700">${escapeHtml(t('badgeInactive'))}</span>` : ''}</div><h3 class="text-base font-extrabold text-warm-900 mt-1.5">${escapeHtml(emp.name)}</h3><p class="text-xs text-stone-500">${escapeHtml(emp.role)}</p></div><div class="bg-white border border-warm-200 px-3 py-1.5 rounded-xl text-center shrink-0"><span class="block text-[10px] text-stone-400 font-bold">PIN</span><span class="font-mono font-extrabold text-sm text-warm-900">${escapeHtml(emp.pin)}</span></div></div>
        <div class="bg-white rounded-xl p-3 border border-warm-200 text-xs space-y-1.5">
          <div class="flex justify-between"><span class="text-stone-500">${escapeHtml(emp.payType === 'MONTHLY' ? t('empCardBaseMonthly') : t('empCardBaseHourly'))}</span><span class="font-mono font-extrabold text-warm-900">${formatMoney(emp.baseRate)}</span></div>
          <div class="flex justify-between"><span class="text-stone-500">${escapeHtml(t('empCardShiftBreak'))}</span><span class="font-mono font-semibold text-warm-800">${escapeHtml(emp.shiftStart)}~${escapeHtml(emp.shiftEnd)} (${emp.breakMinutes ?? 60}${escapeHtml(t('unitMin'))})</span></div>
          <div class="flex justify-between"><span class="text-stone-500">${escapeHtml(t('empCardOffSso'))}</span><span class="font-semibold text-warm-800">${escapeHtml(off)} · ${escapeHtml(emp.ssoEligible ? t('ssoApplied') : t('ssoNotApplied'))}</span></div>
          <div class="flex justify-between"><span class="text-stone-500">${escapeHtml(t('empCardAttBonus'))}</span><span class="font-semibold ${attBonusElig ? 'text-emerald-700' : 'text-stone-500'}">${escapeHtml(attBonusElig ? t('attBonusApplied') : t('attBonusNotApplied'))}</span></div>
          <div class="flex justify-between"><span class="text-stone-500">${escapeHtml(t('empCardAnnualLeave'))}</span><span class="font-mono font-bold ${lStats.remaining <= 0 ? 'text-rose-600' : 'text-emerald-700'}">${lStats.remaining} / ${lStats.quota}${escapeHtml(unitD)}</span></div>
          ${hireStr ? `<div class="flex justify-between pt-1 border-t border-warm-100"><span class="text-stone-500">${escapeHtml(t('empCardHireDate'))}</span><span class="font-mono text-warm-800">${escapeHtml(hireStr)}</span></div>` : ''}
          ${emp.phone ? `<div class="flex justify-between"><span class="text-stone-500">${escapeHtml(t('empCardPhone'))}</span><span class="font-mono text-warm-800">${escapeHtml(emp.phone)}</span></div>` : ''}
          ${bankStr ? `<div class="flex justify-between gap-2"><span class="text-stone-500 shrink-0">${escapeHtml(t('empCardBank'))}</span><span class="font-mono text-warm-800 truncate">${escapeHtml(bankStr)}</span></div>` : ''}
        </div>
      </div>
      <div class="flex gap-2"><button type="button" onclick="HR.openEmployeeModal('${emp.id}')" class="flex-1 py-2 rounded-xl bg-white border border-warm-300 hover:bg-warm-100 text-xs font-bold text-warm-900">${escapeHtml(t('btnEdit'))}</button><button type="button" onclick="HR.toggleEmployeeActive('${emp.id}')" class="px-3 py-2 rounded-xl bg-white border border-warm-300 hover:bg-warm-100 text-xs font-bold text-stone-600">${escapeHtml(act ? t('btnDeactivate') : t('btnRestore'))}</button><button type="button" onclick="HR.confirmDeleteEmployee('${emp.id}')" class="px-3 py-2 rounded-xl bg-white border border-rose-200 hover:bg-rose-50 text-xs font-bold text-rose-600">${escapeHtml(t('btnDelete'))}</button></div>
    </div>`;
  }).join('');
}

function renderSettingsTab() {
  const ni = document.getElementById('setting-store-name'); if (ni && document.activeElement !== ni) ni.value = state.settings.storeName || DEFAULT_SETTINGS.storeName;
  const ti = document.getElementById('setting-store-taxid'); if (ti && document.activeElement !== ti) ti.value = state.settings.storeTaxId || '';
  const ai = document.getElementById('setting-store-address'); if (ai && document.activeElement !== ai) ai.value = state.settings.storeAddress ?? 'Chiang Rai, Thailand';
  const kUrl = document.getElementById('setting-kiosk-url'); if (kUrl) kUrl.value = buildRoleUrl('kiosk');
  const aUrl = document.getElementById('setting-admin-url'); if (aUrl) aUrl.value = buildRoleUrl('admin');
  const ft = document.getElementById('setting-firebase-json'); if (ft && document.activeElement !== ft && activeCustomConfigObj && !ft.value) ft.value = JSON.stringify(activeCustomConfigObj, null, 2);
  updateDeviceKioskPinUI();
  if (window.HR && window.HR.updateCleanupPreview) window.HR.updateCleanupPreview();
}

function downloadCSV(filename, rows) {
  const csv = '\uFEFF' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

window.HR = {
  async changeLanguage(lang, saveToStore = false) {
    if (!I18N[lang]) return;
    if (saveToStore) { previewLanguage = null; try { window.sessionStorage.removeItem(SESSION_LANG_PREVIEW_KEY); } catch (e) {} await persistSettings({ language: lang }); showToast(t('toastLangSaved'), 'success'); }
    else { previewLanguage = lang; try { window.sessionStorage.setItem(SESSION_LANG_PREVIEW_KEY, lang); } catch (e) {} renderAllActiveViews(); showToast(t('toastLangPreview'), 'info'); }
  },
  setPayslipLang(lang) {
    if (!currentPayslipCtx || currentPayslipCtx.type !== 'payslip') return;
    currentPayslipCtx.lang = I18N[lang] ? lang : 'ko';
    renderPayslipDocument();
  },
  setTawiLang(lang) {
    tawiDocLang = lang === 'thEn' ? 'thEn' : 'th';
    if (currentTawiState) {
      currentPayslipCtx = { type: 'tawi', empId: currentTawiState.empId, year: currentTawiState.year, docLang: tawiDocLang };
      render50Tawi(currentTawiState.empId, currentTawiState.year);
    }
  },
  async downloadPayslipImage() {
    setPayslipImageButtonsBusy(true);
    showToast(t('toastImgGenerating'), 'info');
    try {
      const blob = await capturePayslipToBlob();
      downloadBlobFile(blob, buildPayslipImageFilename());
      showToast(t('toastImgSaved'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('toastImgError'), 'error');
    } finally {
      setPayslipImageButtonsBusy(false);
    }
  },
  async sharePayslipImage() {
    setPayslipImageButtonsBusy(true);
    showToast(t('toastImgGenerating'), 'info');
    try {
      const blob = await capturePayslipToBlob();
      const filename = buildPayslipImageFilename();
      const file = new File([blob], filename, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: filename });
        } catch (shareErr) {
          if (shareErr && shareErr.name === 'AbortError') return;
          throw shareErr;
        }
      } else {
        downloadBlobFile(blob, filename);
        showToast(t('toastImgShareFallback'), 'info');
      }
    } catch (err) {
      console.error(err);
      showToast(t('toastImgError'), 'error');
    } finally {
      setPayslipImageButtonsBusy(false);
    }
  },
  async toggleKioskWakeLock() {
    if (wakeLockSentinel || wakeLockDesired) {
      wakeLockDesired = false;
      safeLocalSet(KIOSK_WAKELOCK_KEY, '0');
      await releaseWakeLock();
      showToast(t('toastWakeOff'), 'info');
    } else {
      wakeLockDesired = true;
      safeLocalSet(KIOSK_WAKELOCK_KEY, '1');
      const ok = await acquireWakeLock(false);
      if (ok) showToast(t('toastWakeOn'), 'success');
    }
  },
  toggleKioskFullscreen() {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    } else {
      if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    }
  },
  async promptPwaInstall(fromKiosk = false) {
    if (fromKiosk) {
      safeLocalSet(KIOSK_DEFAULT_KEY, '1');
      updateDeviceKioskPinUI();
    }
    if (deferredInstallPrompt) {
      try {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
      } catch (e) {}
      deferredInstallPrompt = null;
      updatePwaInstallUI();
    } else {
      showToast(t('toastInstallIosHint'), 'info');
    }
  },
  toggleDeviceKioskPin() {
    const isPinned = safeLocalGet(KIOSK_DEFAULT_KEY) === '1';
    if (isPinned) {
      safeLocalRemove(KIOSK_DEFAULT_KEY);
      showToast(t('toastKioskUnpinned'), 'info');
    } else {
      safeLocalSet(KIOSK_DEFAULT_KEY, '1');
      showToast(t('toastKioskPinned'), 'success');
    }
    updateDeviceKioskPinUI();
  },
  toggleKioskCamera() { kioskVirtualMode = !kioskVirtualMode; if (kioskVirtualMode) stopKioskCamera(); else if (kioskSelectedEmpId) initKioskCamera(); else updateCameraStatusUI(); },
  selectKioskEmp(empId) { kioskSelectedEmpId = empId; kioskPinBuffer = ''; updateKioskPinDots(); renderKioskView(); scheduleKioskIdleReset(); if (!kioskVirtualMode) initKioskCamera(); },
  kioskPinPress(digit) {
    if (kioskPinBuffer.length >= 4) return;
    kioskPinBuffer += digit; updateKioskPinDots(); scheduleKioskIdleReset();
    if (kioskPinBuffer.length === 4) {
      const m = state.employees.filter(e => e.active !== false).find(e => e.pin === kioskPinBuffer);
      if (m) {
        if (!kioskSelectedEmpId || kioskSelectedEmpId === m.id) { kioskSelectedEmpId = m.id; renderKioskView(); document.getElementById('kiosk-pin-hint').textContent = t('kioskPinHintMatched', { name: m.name }); if (!kioskVirtualMode && !kioskStream) initKioskCamera(); }
        else document.getElementById('kiosk-pin-hint').textContent = t('kioskPinHintMismatch');
      } else document.getElementById('kiosk-pin-hint').textContent = t('kioskPinHintNotFound');
    }
  },
  kioskPinBackspace() { kioskPinBuffer = kioskPinBuffer.slice(0, -1); updateKioskPinDots(); renderKioskView(); scheduleKioskIdleReset(); },
  kioskPinClear(resetSelected = true) { kioskPinBuffer = ''; updateKioskPinDots(); if (resetSelected) { kioskSelectedEmpId = null; stopKioskCamera(); clearKioskIdleTimer(); } renderKioskView(); },
  async submitKioskPunch(dir) {
    if (kioskPinBuffer.length !== 4) { showToast(t('toastPinIncomplete'), 'warning'); return; }
    const emp = state.employees.filter(e => e.active !== false).find(e => e.pin === kioskPinBuffer);
    if (!emp) { showToast(t('toastPinWrong'), 'error'); this.kioskPinClear(false); return; }
    if (kioskSelectedEmpId && kioskSelectedEmpId !== emp.id) { showToast(t('toastPinMismatch'), 'error'); this.kioskPinClear(false); return; }
    const today = getTodayStr(), nowTime = getNowTimeStr(), nowTs = Date.now(), existing = state.attendance.find(l => l.empId === emp.id && l.date === today);
    if (dir === 'IN') {
      if (existing && existing.clockIn) { showToast(t('toastAlreadyIn', { name: emp.name, time: existing.clockIn }), 'warning'); this.kioskPinClear(true); return; }
      if (!kioskVirtualMode && !kioskStream) await initKioskCamera();
      const inPhoto = captureCompressedSelfie(emp.name, t('selfieLabelIn')); stopKioskCamera();
      const eff = getEffectiveShiftForDate(emp, today);
      const inM = timeToMinutes(nowTime), sStart = timeToMinutes(eff.shiftStart) ?? 540, grace = Number(state.settings.lateGraceMinutes ?? 10), lateMinutes = (inM !== null && inM > sStart + grace) ? (inM - sStart) : 0;
      const newLog = { id: `att_${nowTs}_${emp.id}`, empId: emp.id, date: today, clockIn: nowTime, clockOut: '', clockInTs: nowTs, clockOutTs: null, lateMinutes, inPhoto, outPhoto: '', note: '' };
      await persistDoc('attendance', newLog.id, newLog);
      showKioskConfirmOverlay(emp.name, 'IN', nowTime, inPhoto, lateMinutes > 0 ? t('kioskInLateNote', { m: lateMinutes }) : t('kioskInOkNote'));
    } else {
      if (!existing || !existing.clockIn) { showToast(t('toastNoClockIn', { name: emp.name }), 'warning'); return; }
      if (existing.clockOut) { showToast(t('toastAlreadyOut', { name: emp.name, time: existing.clockOut }), 'warning'); this.kioskPinClear(true); return; }
      if (!kioskVirtualMode && !kioskStream) await initKioskCamera();
      const outPhoto = captureCompressedSelfie(emp.name, t('selfieLabelOut')); stopKioskCamera();
      await persistDoc('attendance', existing.id, { ...existing, clockOut: nowTime, clockOutTs: nowTs, outPhoto });
      showKioskConfirmOverlay(emp.name, 'OUT', nowTime, outPhoto, t('kioskOutNote'));
    }
    this.kioskPinClear(true);
  },
  handleAdminLogin(e) {
    e.preventDefault(); const inp = document.getElementById('admin-pin-input');
    if (inp.value.trim() === (state.settings.adminPin || '000000')) { isAdminUnlocked = true; try { window.sessionStorage.setItem(ADMIN_AUTH_SESSION_KEY, 'true'); } catch (err) {} inp.value = ''; applyRouteUI(); this.switchAdminTab('logs'); showToast(t('toastLoginOk'), 'success'); }
    else { showToast(t('toastLoginFail'), 'error'); inp.value = ''; inp.focus(); }
  },
  logoutAdmin() { isAdminUnlocked = false; try { window.sessionStorage.removeItem(ADMIN_AUTH_SESSION_KEY); } catch (err) {} applyRouteUI(); showToast(t('toastLogoutOk')); },
  openKioskPreviewFromAdmin() { window.location.href = buildRoleUrl('kiosk'); },
  copyRoleUrl(mode) { const u = buildRoleUrl(mode), ok = copyTextSafe(u), lbl = mode === 'kiosk' ? t('urlKioskLabel') : t('urlAdminLabel'); if (u.startsWith('blob:')) showToast(t('toastBlobUrlWarn', { label: lbl }), 'warning'); else if (ok) showToast(t('toastCopyOk', { label: lbl }), 'success'); else showToast(t('toastCopyFail'), 'error'); },
  switchAdminTab(tab) {
    activeAdminTab = tab; document.querySelectorAll('.admin-panel').forEach(p => p.classList.add('hidden'));
    document.getElementById(`panel-${tab}`)?.classList.remove('hidden');
    document.querySelectorAll('.admin-tab-btn').forEach(b => { b.className = b.dataset.tab === tab ? 'admin-tab-btn px-4 py-2.5 rounded-xl text-sm font-bold whitespace-nowrap transition flex items-center gap-2 bg-wood-600 text-white shadow-sm' : 'admin-tab-btn px-4 py-2.5 rounded-xl text-sm font-bold whitespace-nowrap transition flex items-center gap-2 bg-warm-100 text-warm-800 hover:bg-warm-200'; });
    renderAllActiveViews();
  },
  closeModal(id) { document.getElementById(id)?.classList.add('hidden'); },
  openConfirm(title, msg, onOk) {
    document.getElementById('confirm-title').textContent = title; document.getElementById('confirm-message').textContent = msg; pendingConfirmAction = onOk;
    document.getElementById('confirm-ok-btn').onclick = async () => { this.closeModal('modal-confirm'); if (pendingConfirmAction) { const fn = pendingConfirmAction; pendingConfirmAction = null; await fn(); } };
    document.getElementById('modal-confirm').classList.remove('hidden');
  },
  onLogMonthChange() { document.getElementById('filter-log-date').value = ''; renderLogsTab(); },
  renderLogsTab() { renderLogsTab(); },
  renderLeavesTab() { renderLeavesTab(); },
  openShiftTemplateModal(tplId = null) {
    const templates = getShiftTemplates();
    if (tplId) {
      const tpl = templates.find(x => x.id === tplId); if (!tpl) return;
      document.getElementById('modal-shift-tpl-title').textContent = t('shiftTplModalEdit');
      document.getElementById('tpl-f-id').value = tpl.id;
      document.getElementById('tpl-f-name').value = tpl.name || '';
      document.getElementById('tpl-f-start').value = tpl.start || '08:00';
      document.getElementById('tpl-f-end').value = tpl.end || '17:00';
      document.getElementById('tpl-f-break').value = tpl.breakMinutes ?? 60;
      document.getElementById('tpl-f-color').value = tpl.color || 'amber';
    } else {
      document.getElementById('modal-shift-tpl-title').textContent = t('shiftTplModalAdd');
      document.getElementById('tpl-f-id').value = '';
      document.getElementById('tpl-f-name').value = '';
      document.getElementById('tpl-f-start').value = '08:00';
      document.getElementById('tpl-f-end').value = '17:00';
      document.getElementById('tpl-f-break').value = 60;
      document.getElementById('tpl-f-color').value = 'amber';
    }
    document.getElementById('modal-shift-template').classList.remove('hidden');
  },
  async saveShiftTemplate(e) {
    e.preventDefault();
    const id = document.getElementById('tpl-f-id').value;
    const name = document.getElementById('tpl-f-name').value.trim();
    const start = document.getElementById('tpl-f-start').value;
    const end = document.getElementById('tpl-f-end').value;
    const breakMinutes = parseInt(document.getElementById('tpl-f-break').value, 10) || 0;
    const color = document.getElementById('tpl-f-color').value || 'amber';
    const cur = [...getShiftTemplates()];
    const tplObj = { id: id || `tpl_${Date.now()}`, name, start, end, breakMinutes, color };
    const idx = cur.findIndex(x => x.id === tplObj.id);
    if (idx !== -1) cur[idx] = tplObj;
    else cur.push(tplObj);
    await persistSettings({ shiftTemplates: cur });
    this.closeModal('modal-shift-template');
    showToast(t('toastShiftTplSaved'), 'success');
  },
  confirmDeleteShiftTemplate(tplId) {
    const cur = getShiftTemplates();
    const tpl = cur.find(x => x.id === tplId);
    if (!tpl) return;
    this.openConfirm(t('confirmDelShiftTplTitle'), t('confirmDelShiftTplMsg', { name: tpl.name }), async () => {
      const nextList = getShiftTemplates().filter(x => x.id !== tplId);
      await persistSettings({ shiftTemplates: nextList });
      showToast(t('toastShiftTplDeleted'));
    });
  },
  shiftWeekOffset(delta) {
    if (delta === 0) shiftWeekStartStr = getMondayOfWeek(getTodayStr());
    else shiftWeekStartStr = addDaysStr(shiftWeekStartStr, delta * 7);
    renderShiftsTab();
  },
  openShiftAssignModal(empId, dateStr) {
    const emp = state.employees.find(e => e.id === empId); if (!emp) return;
    const curSched = state.schedules[`${dateStr}_${empId}`] || null;
    document.getElementById('modal-shift-assign-title').textContent = t('shiftAssignModalTitle', { name: emp.name, date: dateStr });
    const templates = getShiftTemplates();
    const tplButtons = templates.map(tpl => {
      const isActive = curSched && !curSched.isOff && curSched.shiftId === tpl.id;
      return `<button type="button" onclick="HR.assignShiftCell('${empId}', '${dateStr}', 'TPL', '${tpl.id}')" class="w-full px-4 py-3 rounded-2xl border text-left flex items-center justify-between gap-2 transition hover:brightness-95 ${getShiftColorClasses(tpl.color)} ${isActive ? 'ring-2 ring-wood-600' : ''}">
        <div>
          <div class="font-extrabold text-sm">${escapeHtml(tpl.name)}</div>
          <div class="text-xs font-mono font-semibold opacity-80">${escapeHtml(tpl.start)} ~ ${escapeHtml(tpl.end)} (${Number(tpl.breakMinutes ?? 60)}${escapeHtml(t('unitMin'))})</div>
        </div>
        ${isActive ? '<span class="text-xs font-extrabold">✓</span>' : ''}
      </button>`;
    }).join('');
    const isOffActive = curSched && curSched.isOff === true;
    const isDefaultActive = !curSched;
    document.getElementById('shift-assign-options').innerHTML = `
      ${tplButtons}
      <button type="button" onclick="HR.assignShiftCell('${empId}', '${dateStr}', 'OFF')" class="w-full px-4 py-3 rounded-2xl border text-left flex items-center justify-between gap-2 transition hover:brightness-95 ${getShiftColorClasses('rose')} ${isOffActive ? 'ring-2 ring-rose-600' : ''}">
        <span class="font-extrabold text-sm">${escapeHtml(t('shiftSetOff'))}</span>
        ${isOffActive ? '<span class="text-xs font-extrabold">✓</span>' : ''}
      </button>
      <button type="button" onclick="HR.assignShiftCell('${empId}', '${dateStr}', 'CLEAR')" class="w-full px-4 py-3 rounded-2xl border border-dashed border-warm-300 bg-warm-50 hover:bg-warm-100 text-warm-900 text-left flex items-center justify-between gap-2 transition ${isDefaultActive ? 'ring-2 ring-stone-400' : ''}">
        <div>
          <div class="font-bold text-xs">${escapeHtml(t('shiftResetDefault'))}</div>
          <div class="text-[11px] font-mono text-stone-500 mt-0.5">${escapeHtml(emp.shiftStart || '09:00')} ~ ${escapeHtml(emp.shiftEnd || '18:00')} (${Number(emp.breakMinutes ?? 60)}${escapeHtml(t('unitMin'))})</div>
        </div>
        ${isDefaultActive ? '<span class="text-xs font-extrabold text-stone-500">✓</span>' : ''}
      </button>`;
    document.getElementById('modal-shift-assign').classList.remove('hidden');
  },
  async assignShiftCell(empId, dateStr, mode, tplId = null) {
    const docId = `${dateStr}_${empId}`;
    if (mode === 'CLEAR') {
      await removeDoc('schedules', docId);
      showToast(t('toastShiftCleared'), 'info');
    } else if (mode === 'OFF') {
      await persistDoc('schedules', docId, { id: docId, date: dateStr, empId, shiftId: 'OFF', shiftName: 'OFF', start: '', end: '', breakMinutes: 0, color: 'rose', isOff: true });
      showToast(t('toastShiftAssigned'), 'success');
    } else if (mode === 'TPL') {
      const tpl = getShiftTemplates().find(x => x.id === tplId);
      if (tpl) {
        await persistDoc('schedules', docId, { id: docId, date: dateStr, empId, shiftId: tpl.id, shiftName: tpl.name, start: tpl.start, end: tpl.end, breakMinutes: Number(tpl.breakMinutes ?? 60), color: tpl.color || 'amber', isOff: false });
        showToast(t('toastShiftAssigned'), 'success');
      }
    }
    this.closeModal('modal-shift-assign');
  },
  confirmCopyPrevWeek() {
    const curDates = getWeekDates(shiftWeekStartStr);
    const activeEmpIds = new Set(state.employees.filter(e => e.active !== false).map(e => e.id));
    const items = [];
    curDates.forEach(targetDate => {
      const prevDate = addDaysStr(targetDate, -7);
      activeEmpIds.forEach(empId => {
        const prevSched = state.schedules[`${prevDate}_${empId}`];
        if (prevSched) items.push({ targetDate, sched: prevSched });
      });
    });
    if (items.length === 0) { showToast(t('toastCopyWeekEmpty'), 'warning'); return; }
    const range = `${curDates[0]} ~ ${curDates[6]}`;
    this.openConfirm(t('confirmCopyWeekTitle'), t('confirmCopyWeekMsg', { count: items.length, range }), async () => {
      for (const it of items) {
        const docId = `${it.targetDate}_${it.sched.empId}`;
        await persistDoc('schedules', docId, { ...it.sched, id: docId, date: it.targetDate });
      }
      showToast(t('toastCopyWeekDone', { count: items.length }), 'success');
    });
  },
  openSelfieModal(logId) {
    const l = state.attendance.find(x => x.id === logId); if (!l) return; const emp = state.employees.find(e => e.id === l.empId);
    document.getElementById('modal-selfie-title').textContent = t('selfieModalTitle', { name: emp ? emp.name : t('thEmployee'), date: l.date });
    document.getElementById('modal-selfie-body').innerHTML = `<div class="space-y-1.5"><div class="text-xs font-bold text-emerald-700">${escapeHtml(t('selfieClockIn', { time: l.clockIn || '-' }))}</div>${l.inPhoto ? `<img src="${l.inPhoto}" class="w-full rounded-2xl border border-warm-200" />` : `<div class="p-6 bg-warm-100 rounded-2xl text-center text-xs text-stone-400">${escapeHtml(t('selfieNoInPhoto'))}</div>`}</div>${l.clockOut ? `<div class="space-y-1.5 pt-2"><div class="text-xs font-bold text-rose-700">${escapeHtml(t('selfieClockOut', { time: l.clockOut }))}</div>${l.outPhoto ? `<img src="${l.outPhoto}" class="w-full rounded-2xl border border-warm-200" />` : `<div class="p-6 bg-warm-100 rounded-2xl text-center text-xs text-stone-400">${escapeHtml(t('selfieNoOutPhoto'))}</div>`}</div>` : ''}`;
    document.getElementById('modal-selfie').classList.remove('hidden');
  },
  openLogModal(logId = null) {
    if (state.employees.length === 0) { showToast(t('toastNeedEmpFirst'), 'warning'); return; }
    const sel = document.getElementById('log-f-emp'); sel.innerHTML = state.employees.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
    if (logId) {
      const l = state.attendance.find(x => x.id === logId); if (!l) return;
      document.getElementById('modal-log-title').textContent = t('logModalEditTitle');
      document.getElementById('log-f-id').value = l.id; sel.value = l.empId; document.getElementById('log-f-date').value = l.date; document.getElementById('log-f-in').value = l.clockIn || ''; document.getElementById('log-f-out').value = l.clockOut || ''; document.getElementById('log-f-note').value = l.note || '';
    } else {
      document.getElementById('modal-log-title').textContent = t('logModalAddTitle');
      document.getElementById('log-f-id').value = ''; document.getElementById('log-f-date').value = getTodayStr(); document.getElementById('log-f-in').value = '09:00'; document.getElementById('log-f-out').value = '18:00'; document.getElementById('log-f-note').value = t('logDefaultManualNote');
    }
    document.getElementById('modal-log').classList.remove('hidden');
  },
  async saveAttendanceLog(e) {
    e.preventDefault();
    const id = document.getElementById('log-f-id').value, empId = document.getElementById('log-f-emp').value, date = document.getElementById('log-f-date').value, clockIn = document.getElementById('log-f-in').value, clockOut = document.getElementById('log-f-out').value, note = document.getElementById('log-f-note').value.trim();
    const emp = state.employees.find(x => x.id === empId), ex = id ? state.attendance.find(l => l.id === id) : null;
    const eff = emp ? getEffectiveShiftForDate(emp, date) : null;
    const inM = timeToMinutes(clockIn), sStart = eff ? (timeToMinutes(eff.shiftStart) ?? 540) : 540, grace = Number(state.settings.lateGraceMinutes ?? 10);
    const lateMinutes = (inM !== null && inM > sStart + grace) ? (inM - sStart) : 0, docId = id || `att_${Date.now()}_${empId}`;
    await persistDoc('attendance', docId, { id: docId, empId, date, clockIn, clockOut, clockInTs: ex?.clockInTs || Date.now(), clockOutTs: clockOut ? (ex?.clockOutTs || Date.now()) : null, lateMinutes, inPhoto: ex?.inPhoto || generateVirtualSelfieJpeg(emp ? emp.name : 'Staff', t('selfieManualIn'), `${date} ${clockIn}`, '#334155'), outPhoto: ex?.outPhoto || (clockOut ? generateVirtualSelfieJpeg(emp ? emp.name : 'Staff', t('selfieManualOut'), `${date} ${clockOut}`, '#475569') : ''), note });
    this.closeModal('modal-log'); showToast(id ? t('toastLogUpdated') : t('toastLogSaved'), 'success');
  },
  confirmDeleteLog(id) { this.openConfirm(t('confirmDelLogTitle'), t('confirmDelLogMsg'), async () => { await removeDoc('attendance', id); showToast(t('toastLogDeleted')); }); },
  exportLogsCSV() {
    const m = document.getElementById('filter-log-month').value || getCurrentMonthStr(), rows = [t('csvLogsHeaders')];
    state.attendance.filter(l => (l.date || '').startsWith(m)).forEach(l => { const emp = state.employees.find(e => e.id === l.empId), a = analyzeAttendance(l, emp); rows.push([l.date, emp ? emp.name : t('deletedEmp'), emp ? emp.role : '', l.clockIn || '', l.clockOut || t('notClockedOut'), a.workedHours, a.otHours, a.holidayHours, a.lateMins, l.note || '']); });
    downloadCSV(`${t('csvLogsPrefix')}_${m}.csv`, rows); showToast(t('toastCsvLogsDone'), 'success');
  },
  renderPayrollTab() { renderPayrollTab(); },
  async savePayrollRules() {
    const rv = parseFloat(document.getElementById('rule-sso-rate').value), cv = parseInt(document.getElementById('rule-sso-cap').value, 10);
    const attAmtVal = parseInt(document.getElementById('rule-att-bonus-amount')?.value, 10);
    await persistSettings({
      otMultiplier: parseFloat(document.getElementById('rule-ot-mult').value) || 1.5,
      holidayOtMultiplier: parseFloat(document.getElementById('rule-hol-mult').value) || 2.0,
      lateGraceMinutes: parseInt(document.getElementById('rule-late-grace').value, 10) || 0,
      lateDeductionEnabled: document.getElementById('rule-late-enabled').checked,
      ssoEnabled: document.getElementById('rule-sso-enabled').checked,
      ssoRateThb: Number.isNaN(rv) ? 5 : rv,
      ssoCapThb: Number.isNaN(cv) ? 875 : cv,
      standardWorkDays: parseInt(document.getElementById('rule-work-days').value, 10) || 26,
      attendanceBonusEnabled: document.getElementById('rule-att-bonus-enabled')?.checked === true,
      attendanceBonusAmount: Number.isNaN(attAmtVal) ? 1000 : Math.max(0, attAmtVal),
      prorataEnabled: document.getElementById('rule-prorata-enabled')?.checked !== false
    });
    showToast(t('toastRulesSaved'), 'success');
  },
  confirmClosePayroll() {
    const m = document.getElementById('payroll-month-input').value || getCurrentMonthStr();
    this.openConfirm(t('confirmClosePayrollTitle'), t('confirmClosePayrollMsg', { month: m }), async () => {
      const rows = state.employees.map(emp => {
        const r = calculateMonthlyPayroll(emp, m);
        return {
          empId: emp.id,
          empSnapshot: { id: emp.id, name: emp.name, role: emp.role, payType: emp.payType, baseRate: emp.baseRate, idNumber: emp.idNumber || '', bankName: emp.bankName || '', bankAccount: emp.bankAccount || '' },
          workDaysCount: r.workDaysCount, totalWorkedHours: r.totalWorkedHours, totalOtHours: r.totalOtHours, totalHolidayHours: r.totalHolidayHours, totalLateMins: r.totalLateMins, unpaidLeaveDays: r.unpaidLeaveDays,
          fullBasePay: r.fullBasePay, basePay: r.basePay, isProrated: r.isProrated, isNotEmployed: r.isNotEmployed, prorataEmployedDays: r.prorataEmployedDays, prorataTotalDays: r.prorataTotalDays,
          otPay: r.otPay, holidayPay: r.holidayPay, attendanceBonus: r.attendanceBonus, extraBonus: r.extraBonus, extraDeduction: r.extraDeduction, adjMemo: r.adjMemo,
          lateDeduction: r.lateDeduction, unpaidDeduction: r.unpaidDeduction, ssoDeduction: r.ssoDeduction, whtDeduction: r.whtDeduction, employerSso: r.employerSso,
          totalEarnings: r.totalEarnings, totalDeductions: r.totalDeductions, netPay: r.netPay, employerTotalCost: r.employerTotalCost,
          transferPaid: false, transferPaidAt: ''
        };
      });
      await persistDoc('payroll_closures', m, {
        id: m, month: m, closedAt: Date.now(), closedDate: getTodayStr(), currency: 'THB',
        rulesSnapshot: {
          otMultiplier: state.settings.otMultiplier ?? 1.5,
          holidayOtMultiplier: state.settings.holidayOtMultiplier ?? 2.0,
          ssoRateThb: state.settings.ssoRateThb ?? 5,
          ssoCapThb: state.settings.ssoCapThb ?? 875,
          standardWorkDays: state.settings.standardWorkDays ?? 26,
          attendanceBonusEnabled: state.settings.attendanceBonusEnabled === true,
          attendanceBonusAmount: state.settings.attendanceBonusAmount ?? 1000,
          prorataEnabled: state.settings.prorataEnabled !== false
        },
        rows
      });
      showToast(t('toastPayrollClosed', { month: m }), 'success');
    });
  },
  confirmReopenPayroll() {
    const m = document.getElementById('payroll-month-input').value || getCurrentMonthStr();
    this.openConfirm(t('confirmReopenPayrollTitle'), t('confirmReopenPayrollMsg', { month: m }), async () => { await removeDoc('payroll_closures', m); showToast(t('toastPayrollReopened', { month: m })); });
  },
  async toggleTransferPaid(month, empId) {
    const cl = state.closures[month]; if (!cl || !Array.isArray(cl.rows)) return; let name = '';
    const nextRows = cl.rows.map(r => { const rid = r.empId || r.empSnapshot?.id; if (rid === empId) { const np = !r.transferPaid; name = r.empSnapshot?.name || ''; return { ...r, transferPaid: np, transferPaidAt: np ? getTodayStr() : '' }; } return r; });
    await persistDoc('payroll_closures', month, { ...cl, rows: nextRows }); showToast(t('toastTransferUpdated', { name }), 'success');
  },
  openAdjModal(empId) {
    const m = document.getElementById('payroll-month-input').value || getCurrentMonthStr(); if (state.closures[m]) return;
    const emp = state.employees.find(e => e.id === empId); if (!emp) return;
    const adj = state.adjustments[`${m}_${empId}`] || { bonus: 0, deduction: 0, wht: 0, memo: '' };
    document.getElementById('modal-adj-title').textContent = t('adjModalTitle', { name: emp.name, month: m });
    document.getElementById('adj-f-emp').value = empId; document.getElementById('adj-f-month').value = m;
    document.getElementById('adj-f-bonus').value = adj.bonus || 0; document.getElementById('adj-f-deduction').value = adj.deduction || 0; document.getElementById('adj-f-wht').value = adj.wht || 0; document.getElementById('adj-f-memo').value = adj.memo || '';
    document.getElementById('modal-adj').classList.remove('hidden');
  },
  estimateMonthlyWht() {
    const empId = document.getElementById('adj-f-emp').value, month = document.getElementById('adj-f-month').value, emp = state.employees.find(e => e.id === empId); if (!emp) return;
    const r = calculateMonthlyPayroll(emp, month), curBonus = Number(document.getElementById('adj-f-bonus').value) || 0;
    const annualTax = computeThaiProgressiveTax((r.basePay + r.otPay + r.holidayPay + (r.attendanceBonus || 0) + curBonus) * 12, r.ssoDeduction * 12);
    document.getElementById('adj-f-wht').value = Math.round(annualTax / 12); showToast(t('toastWhtEstimated'), 'info');
  },
  async savePayrollAdjustment(e) {
    e.preventDefault(); const empId = document.getElementById('adj-f-emp').value, month = document.getElementById('adj-f-month').value, docId = `${month}_${empId}`;
    await persistDoc('payroll_adjustments', docId, { id: docId, month, empId, bonus: Number(document.getElementById('adj-f-bonus').value) || 0, deduction: Number(document.getElementById('adj-f-deduction').value) || 0, wht: Number(document.getElementById('adj-f-wht').value) || 0, memo: document.getElementById('adj-f-memo').value.trim() });
    this.closeModal('modal-adj'); showToast(t('toastAdjSaved'), 'success');
  },
  openPayslipModal(empId) {
    currentTawiState = null;
    document.getElementById('tawi-lang-bar')?.classList.add('hidden');
    document.getElementById('payslip-lang-bar')?.classList.remove('hidden');
    const m = document.getElementById('payroll-month-input').value || getCurrentMonthStr();
    currentPayslipCtx = { type: 'payslip', empId, month: m, lang: getLang() };
    renderPayslipDocument();
    document.getElementById('modal-payslip').classList.remove('hidden');
  },
  exportPayrollCSV() {
    const m = document.getElementById('payroll-month-input').value || getCurrentMonthStr(), view = getPayrollViewData(m), rows = [t('csvPayrollHeaders')];
    view.rows.forEach(r => { rows.push([m, r.emp.name, r.emp.role, r.emp.payType === 'MONTHLY' ? t('payTypeMonthly') : t('payTypeHourly'), r.workDaysCount, r.totalWorkedHours, r.totalOtHours, r.totalHolidayHours, r.unpaidLeaveDays, r.basePay, r.otPay, r.holidayPay, r.attendanceBonus || 0, r.extraBonus, r.lateDeduction, r.unpaidDeduction, r.extraDeduction, r.ssoDeduction, r.whtDeduction, r.employerSso, r.employerTotalCost, r.netPay, r.emp.idNumber || '', r.emp.bankName || '', r.emp.bankAccount || '', view.isClosed ? t('payslipClosedBadge') : t('badgePayrollOpen'), view.isClosed ? (r.transferPaid ? t('statusPaid') : t('statusUnpaid')) : '-']); });
    downloadCSV(`${t('csvPayrollPrefix')}_${m}.csv`, rows); showToast(t('toastCsvPayrollDone'), 'success');
  },
  exportSsoCSV() {
    const m = document.getElementById('payroll-month-input').value || getCurrentMonthStr(), view = getPayrollViewData(m), rows = [t('csvSsoHeaders')], ssoRows = view.rows.filter(r => r.ssoDeduction > 0 || r.employerSso > 0 || r.emp?.ssoEligible);
    (ssoRows.length > 0 ? ssoRows : view.rows).forEach(r => { rows.push([m, r.emp.name, r.emp.idNumber || '', r.basePay, r.ssoDeduction, r.employerSso, r.ssoDeduction + r.employerSso]); });
    downloadCSV(`${t('csvSsoPrefix')}_${m}.csv`, rows); showToast(t('toastCsvSsoDone'), 'success');
  },
  exportBankTransferCSV() {
    const m = document.getElementById('payroll-month-input').value || getCurrentMonthStr(), view = getPayrollViewData(m), rows = [t('csvBankHeaders')];
    view.rows.forEach(r => { rows.push([m, r.emp.bankName || '', r.emp.bankAccount || '', r.emp.name, r.netPay, `Salary ${m}`, r.transferPaid ? t('csvStatusPaid') : t('csvStatusUnpaid')]); });
    downloadCSV(`${t('csvBankPrefix')}_${m}.csv`, rows); showToast(t('toastCsvBankDone'), 'success');
  },
  openAnnualTaxModal() {
    const sel = document.getElementById('annual-year-select'), curYear = Number((document.getElementById('payroll-month-input').value || getCurrentMonthStr()).slice(0, 4)) || new Date().getFullYear(), yearSet = new Set([curYear - 2, curYear - 1, curYear, curYear + 1]);
    state.attendance.forEach(a => { const y = Number((a.date || '').slice(0, 4)); if (y > 2000) yearSet.add(y); });
    Object.keys(state.closures).forEach(k => { const y = Number(k.slice(0, 4)); if (y > 2000) yearSet.add(y); });
    sel.innerHTML = Array.from(yearSet).sort((a, b) => b - a).map(y => `<option value="${y}">${y}</option>`).join('');
    sel.value = String(curYear); this.renderAnnualTaxModal(); document.getElementById('modal-annual-tax').classList.remove('hidden');
  },
  renderAnnualTaxModal() {
    const year = document.getElementById('annual-year-select').value || getCurrentMonthStr().slice(0, 4), summary = computeAnnualTaxSummary(year);
    document.getElementById('annual-modal-title').textContent = t('annualModalTitle', { year });
    document.getElementById('annual-closed-badge').textContent = t('annualClosedCount', { c: summary.closedCount });
    const tb = document.getElementById('annual-tax-tbody');
    tb.innerHTML = summary.items.length === 0 ? `<tr><td colspan="7" class="py-10 text-center text-stone-400 text-xs">${escapeHtml(t('payrollEmpty'))}</td></tr>` : summary.items.map(it => `<tr class="hover:bg-warm-50/80"><td class="py-3 px-4"><div class="font-bold text-warm-900">${escapeHtml(it.emp.name)}</div><div class="text-[11px] font-mono text-stone-500">${escapeHtml(it.emp.idNumber || '-')}</div></td><td class="py-3 px-4 text-right font-mono font-bold text-warm-900">${formatMoney(it.gross)}</td><td class="py-3 px-4 text-right font-mono font-bold text-indigo-700">${formatMoney(it.wht)}</td><td class="py-3 px-4 text-right font-mono text-xs text-stone-700">${formatMoney(it.empSso)}</td><td class="py-3 px-4 text-right font-mono text-xs text-sky-800">${formatMoney(it.erSso)}</td><td class="py-3 px-4 text-right font-mono font-extrabold text-wood-700">${formatMoney(it.net)}</td><td class="py-3 px-4 text-center"><button type="button" onclick="HR.open50TawiModal('${it.empId}')" class="px-3 py-1.5 rounded-xl bg-warm-900 hover:bg-black text-white text-xs font-bold">${escapeHtml(t('btnPrint50Tawi'))}</button></td></tr>`).join('');
  },
  exportAnnualTaxCSV() {
    const year = document.getElementById('annual-year-select').value || getCurrentMonthStr().slice(0, 4), summary = computeAnnualTaxSummary(year), rows = [t('csvAnnualHeaders')];
    summary.items.forEach(it => { rows.push([year, it.emp.name, it.emp.idNumber || '', it.emp.hireDate || '', it.emp.resignDate || '', it.gross, it.wht, it.empSso, it.erSso, it.net]); });
    downloadCSV(`${t('csvAnnualPrefix')}_${year}.csv`, rows); showToast(t('toastCsvAnnualDone'), 'success');
  },
  open50TawiModal(empId) {
    const year = document.getElementById('annual-year-select').value || getCurrentMonthStr().slice(0, 4);
    currentTawiState = { empId, year }; tawiDocLang = 'th';
    currentPayslipCtx = { type: 'tawi', empId, year, docLang: tawiDocLang };
    document.getElementById('payslip-lang-bar')?.classList.add('hidden');
    document.getElementById('tawi-lang-bar')?.classList.remove('hidden');
    render50Tawi(empId, year);
    document.getElementById('modal-payslip').classList.remove('hidden');
  },
  async toggleWeeklyOff(idx) { const c = new Set(state.settings.weeklyOffDays || []); if (c.has(idx)) c.delete(idx); else c.add(idx); await persistSettings({ weeklyOffDays: Array.from(c).sort() }); },
  async addHoliday() {
    const date = document.getElementById('input-hol-date').value, name = document.getElementById('input-hol-name').value.trim();
    if (!date || !name) { showToast(t('toastHolNeedFields'), 'warning'); return; }
    const id = `hol_${Date.now()}`; await persistDoc('holidays', id, { id, date, name }); document.getElementById('input-hol-name').value = ''; showToast(t('toastHolAdded'), 'success');
  },
  async deleteHoliday(id) { await removeDoc('holidays', id); showToast(t('toastHolDeleted')); },
  openLeaveModal() {
    if (state.employees.length === 0) { showToast(t('toastNeedEmpFirst'), 'warning'); return; }
    document.getElementById('leave-f-emp').innerHTML = state.employees.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
    document.getElementById('leave-f-date').value = getTodayStr(); document.getElementById('leave-f-reason').value = '';
    this.syncLeavePaidDefault(); this.updateLeaveModalHint(); document.getElementById('modal-leave').classList.remove('hidden');
  },
  updateLeaveModalHint() {
    const empId = document.getElementById('leave-f-emp')?.value, dateVal = document.getElementById('leave-f-date')?.value || getTodayStr(), hintEl = document.getElementById('leave-modal-remain-hint');
    if (!hintEl) return;
    const emp = state.employees.find(e => e.id === empId); if (!emp) { hintEl.classList.add('hidden'); return; }
    const year = dateVal.slice(0, 4) || getTodayStr().slice(0, 4), st = getEmployeeLeaveStats(emp, year);
    hintEl.classList.remove('hidden');
    hintEl.className = `text-xs font-bold px-3 py-2 rounded-xl border ${st.remaining <= 0 ? 'bg-rose-50 border-rose-200 text-rose-700' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`;
    hintEl.textContent = t('leaveModalRemainHint', { year, rem: st.remaining, quota: st.quota, used: st.used });
  },
  syncLeavePaidDefault() { const tp = document.getElementById('leave-f-type').value; document.getElementById('leave-f-paid').value = (tp === 'ANNUAL' || tp === 'SICK') ? 'true' : 'false'; },
  async saveLeave(e) {
    e.preventDefault(); const id = `lv_${Date.now()}`;
    await persistDoc('leaves', id, { id, empId: document.getElementById('leave-f-emp').value, type: document.getElementById('leave-f-type').value, isPaid: document.getElementById('leave-f-paid').value === 'true', date: document.getElementById('leave-f-date').value, reason: document.getElementById('leave-f-reason').value.trim(), status: 'APPROVED' });
    this.closeModal('modal-leave'); showToast(t('toastLeaveAdded'), 'success');
  },
  async setLeaveStatus(id, st) { const tg = state.leaves.find(x => x.id === id); if (!tg) return; await persistDoc('leaves', id, { ...tg, status: st }); showToast(st === 'APPROVED' ? t('toastLeaveApproved') : t('toastLeaveRejected'), 'success'); },
  async deleteLeave(id) { await removeDoc('leaves', id); showToast(t('toastLeaveDeleted')); },
  updateEmpRateLabel() { document.getElementById('emp-f-rate-label').textContent = document.getElementById('emp-f-paytype').value === 'MONTHLY' ? t('empFRateMonthly') : t('empFRateHourly'); },
  applyShiftPresetToEmpForm() {
    const tplId = document.getElementById('emp-f-shift-preset')?.value;
    if (!tplId) return;
    const tpl = getShiftTemplates().find(x => x.id === tplId);
    if (!tpl) return;
    document.getElementById('emp-f-start').value = tpl.start || '09:00';
    document.getElementById('emp-f-end').value = tpl.end || '18:00';
    document.getElementById('emp-f-break').value = tpl.breakMinutes ?? 60;
  },
  openEmployeeModal(empId = null) {
    const presetEl = document.getElementById('emp-f-shift-preset');
    if (presetEl) {
      presetEl.innerHTML = `<option value="">${escapeHtml(t('empFShiftPresetPh'))}</option>` +
        getShiftTemplates().map(tpl => `<option value="${tpl.id}">${escapeHtml(tpl.name)} (${escapeHtml(tpl.start)}~${escapeHtml(tpl.end)}, ${Number(tpl.breakMinutes ?? 60)}${escapeHtml(t('unitMin'))})</option>`).join('');
      presetEl.value = '';
    }
    const attBonusEl = document.getElementById('emp-f-att-bonus');
    if (empId) {
      const emp = state.employees.find(e => e.id === empId); if (!emp) return;
      document.getElementById('modal-emp-title').textContent = t('empModalEditTitle');
      document.getElementById('emp-f-id').value = emp.id; document.getElementById('emp-f-name').value = emp.name; document.getElementById('emp-f-role').value = emp.role;
      document.getElementById('emp-f-pin').value = emp.pin; document.getElementById('emp-f-paytype').value = emp.payType; document.getElementById('emp-f-rate').value = emp.baseRate;
      document.getElementById('emp-f-break').value = emp.breakMinutes ?? 60; document.getElementById('emp-f-start').value = emp.shiftStart || '09:00'; document.getElementById('emp-f-end').value = emp.shiftEnd || '18:00';
      document.getElementById('emp-f-dayoff').value = String(emp.weeklyDayOff ?? -1); document.getElementById('emp-f-sso').checked = emp.ssoEligible !== false; document.getElementById('emp-f-active').checked = emp.active !== false;
      if (attBonusEl) attBonusEl.checked = emp.attendanceBonusEligible !== undefined ? !!emp.attendanceBonusEligible : (emp.payType === 'MONTHLY');
      document.getElementById('emp-f-idnum').value = emp.idNumber || ''; document.getElementById('emp-f-phone').value = emp.phone || '';
      document.getElementById('emp-f-bank').value = emp.bankName || ''; document.getElementById('emp-f-account').value = emp.bankAccount || '';
      document.getElementById('emp-f-hire').value = emp.hireDate || ''; document.getElementById('emp-f-resign').value = emp.resignDate || '';
      document.getElementById('emp-f-annual-quota').value = emp.annualLeaveQuota ?? 6;
    } else {
      document.getElementById('modal-emp-title').textContent = t('empModalAddTitle');
      document.getElementById('emp-f-id').value = ''; document.getElementById('emp-f-name').value = ''; document.getElementById('emp-f-role').value = '';
      document.getElementById('emp-f-pin').value = String(Math.floor(1000 + Math.random() * 9000)); document.getElementById('emp-f-paytype').value = 'MONTHLY'; document.getElementById('emp-f-rate').value = '';
      document.getElementById('emp-f-break').value = 60; document.getElementById('emp-f-start').value = '09:00'; document.getElementById('emp-f-end').value = '18:00';
      document.getElementById('emp-f-dayoff').value = '-1'; document.getElementById('emp-f-sso').checked = true; document.getElementById('emp-f-active').checked = true;
      if (attBonusEl) attBonusEl.checked = true;
      document.getElementById('emp-f-annual-quota').value = 6;
      ['emp-f-idnum', 'emp-f-phone', 'emp-f-bank', 'emp-f-account', 'emp-f-hire', 'emp-f-resign'].forEach(k => { document.getElementById(k).value = ''; });
    }
    this.updateEmpRateLabel(); document.getElementById('modal-employee').classList.remove('hidden');
  },
  async saveEmployee(e) {
    e.preventDefault();
    const id = document.getElementById('emp-f-id').value, pin = document.getElementById('emp-f-pin').value.trim(), dup = state.employees.find(x => x.pin === pin && x.id !== id);
    if (dup) { showToast(t('toastEmpPinDup', { pin, name: dup.name }), 'error'); return; }
    const ex = id ? state.employees.find(x => x.id === id) : null, docId = id || `emp_${Date.now()}`, qVal = parseInt(document.getElementById('emp-f-annual-quota').value, 10);
    await persistDoc('employees', docId, {
      id: docId,
      name: document.getElementById('emp-f-name').value.trim(),
      role: document.getElementById('emp-f-role').value.trim(),
      pin,
      payType: document.getElementById('emp-f-paytype').value,
      baseRate: Number(document.getElementById('emp-f-rate').value) || 0,
      breakMinutes: parseInt(document.getElementById('emp-f-break').value, 10) || 0,
      shiftStart: document.getElementById('emp-f-start').value,
      shiftEnd: document.getElementById('emp-f-end').value,
      weeklyDayOff: parseInt(document.getElementById('emp-f-dayoff').value, 10),
      annualLeaveQuota: Number.isNaN(qVal) ? 6 : qVal,
      ssoEligible: document.getElementById('emp-f-sso').checked,
      attendanceBonusEligible: document.getElementById('emp-f-att-bonus')?.checked !== false,
      active: document.getElementById('emp-f-active').checked,
      idNumber: document.getElementById('emp-f-idnum').value.trim(),
      phone: document.getElementById('emp-f-phone').value.trim(),
      bankName: document.getElementById('emp-f-bank').value.trim(),
      bankAccount: document.getElementById('emp-f-account').value.trim(),
      hireDate: document.getElementById('emp-f-hire').value,
      resignDate: document.getElementById('emp-f-resign').value,
      createdAt: ex?.createdAt || Date.now()
    });
    this.closeModal('modal-employee'); showToast(id ? t('toastEmpUpdated') : t('toastEmpSaved'), 'success');
  },
  async toggleEmployeeActive(empId) {
    const emp = state.employees.find(e => e.id === empId); if (!emp) return; const nxt = emp.active === false;
    await persistDoc('employees', empId, { ...emp, active: nxt }); showToast(nxt ? t('toastEmpRestored', { name: emp.name }) : t('toastEmpDeactivated', { name: emp.name }));
  },
  confirmDeleteEmployee(empId) {
    const emp = state.employees.find(e => e.id === empId);
    this.openConfirm(t('confirmDelEmpTitle'), t('confirmDelEmpMsg', { name: emp ? emp.name : '' }), async () => { await removeDoc('employees', empId); showToast(t('toastEmpDeleted')); });
  },
  confirmClearSampleData() {
    this.openConfirm(t('confirmClearSampleTitle'), t('confirmClearSampleMsg'), async () => {
      for (const x of state.employees.filter(e => e.isSample || e.id.startsWith('sample_'))) await removeDoc('employees', x.id);
      for (const x of state.attendance.filter(a => a.isSample || a.id.startsWith('sample_'))) await removeDoc('attendance', x.id);
      for (const x of state.leaves.filter(l => l.isSample || l.id.startsWith('sample_'))) await removeDoc('leaves', x.id);
      for (const x of state.holidays.filter(h => h.isSample || h.id.startsWith('sample_'))) await removeDoc('holidays', x.id);
      await persistSettings({ seeded: true }); showToast(t('toastSampleCleared'), 'success');
    });
  },
  updateCleanupPreview() {
    const el = document.getElementById('cleanup-preview-text'); if (!el) return;
    const { targets, kb } = getOldSelfieCleanupTargets();
    el.textContent = targets.length === 0 ? t('cleanupNone') : t('cleanupPreview', { count: targets.length, kb });
  },
  confirmCleanOldSelfies() {
    const { cutoffDateStr, targets } = getOldSelfieCleanupTargets();
    if (targets.length === 0) { showToast(t('cleanupNone'), 'info'); return; }
    this.openConfirm(t('confirmCleanTitle'), t('confirmCleanMsg', { date: cutoffDateStr, count: targets.length }), async () => {
      for (const log of targets) await persistDoc('attendance', log.id, { ...log, inPhoto: '', outPhoto: '' });
      showToast(t('toastCleanDone', { count: targets.length }), 'success');
      this.updateCleanupPreview();
    });
  },
  exportFullBackupJSON() {
    const backupObj = { version: 3, exportedAt: new Date().toISOString(), appId: activeAppId, data: { settings: state.settings, employees: state.employees, attendance: state.attendance, leaves: state.leaves, holidays: state.holidays, adjustments: state.adjustments, closures: state.closures, schedules: state.schedules } };
    const blob = new Blob([JSON.stringify(backupObj, null, 2)], { type: 'application/json;charset=utf-8;' }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `hr_backup_${getTodayStr()}.json`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast(t('toastBackupExported'), 'success');
  },
  triggerBackupRestore() { document.getElementById('backup-file-input')?.click(); },
  handleBackupFileSelect(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ''));
        if (!parsed?.data || !Array.isArray(parsed.data.employees) || !parsed.data.settings) { showToast(t('toastRestoreInvalid'), 'error'); return; }
        const d = parsed.data, emps = d.employees.length, logs = (d.attendance || []).length, closures = Object.keys(d.closures || {}).length;
        this.openConfirm(t('confirmRestoreTitle'), t('confirmRestoreMsg', { emps, logs, closures }), async () => {
          await persistSettings({ ...DEFAULT_SETTINGS, ...d.settings, currency: 'THB', seeded: true });
          for (const x of (d.employees || [])) { if (x?.id) await persistDoc('employees', x.id, x); }
          for (const x of (d.attendance || [])) { if (x?.id) await persistDoc('attendance', x.id, x); }
          for (const x of (d.leaves || [])) { if (x?.id) await persistDoc('leaves', x.id, x); }
          for (const x of (d.holidays || [])) { if (x?.id) await persistDoc('holidays', x.id, x); }
          for (const [k, v] of Object.entries(d.adjustments || {})) { if (v) await persistDoc('payroll_adjustments', v.id || k, { ...v, id: v.id || k }); }
          for (const [k, v] of Object.entries(d.closures || {})) { if (v) await persistDoc('payroll_closures', v.id || k, { ...v, id: v.id || k }); }
          for (const [k, v] of Object.entries(d.schedules || {})) { if (v) await persistDoc('schedules', v.id || k, { ...v, id: v.id || k }); }
          showToast(t('toastRestoreDone'), 'success'); renderAllActiveViews();
        });
      } catch (err) { showToast(t('toastRestoreInvalid'), 'error'); }
    };
    reader.readAsText(file);
  },
  async saveStoreBasicSettings(e) {
    e.preventDefault();
    const sn = document.getElementById('setting-store-name').value.trim(), st = document.getElementById('setting-store-taxid').value.trim(), sa = document.getElementById('setting-store-address').value.trim(), np = document.getElementById('setting-new-pin').value.trim();
    const patch = { storeName: sn || DEFAULT_SETTINGS.storeName, storeTaxId: st, storeAddress: sa || 'Chiang Rai, Thailand' };
    if (np) { if (!/^\d{6}$/.test(np)) { showToast(t('toastPinSixDigits'), 'error'); return; } patch.adminPin = np; }
    await persistSettings(patch); document.getElementById('setting-new-pin').value = ''; showToast(t('toastBasicSaved'), 'success');
  },
  async saveCustomFirebaseConfig() {
    const raw = document.getElementById('setting-firebase-json').value.trim(); if (!raw) { showToast(t('toastFbNeedJson'), 'warning'); return; }
    try {
      let p; try { p = JSON.parse(raw); } catch { p = JSON.parse(raw.replace(/const\s+\w+\s*=\s*/, '').replace(/;\s*$/, '').replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":').replace(/'/g, '"').replace(/,\s*}/g, '}')); }
      if (!p || !p.apiKey || !p.projectId) throw new Error(t('toastFbMissingField'));
      safeLocalSet(LOCAL_FB_CFG_KEY, JSON.stringify(p)); activeCustomConfigObj = p;
      showToast(t('toastFbSaved'), 'success'); await initDataLayer(); renderSettingsTab();
    } catch (err) { showToast(t('toastFbBadJson', { err: err.message }), 'error'); }
  },
  async clearCustomFirebaseConfig() {
    safeLocalRemove(LOCAL_FB_CFG_KEY); activeCustomConfigObj = null; document.getElementById('setting-firebase-json').value = '';
    showToast(t('toastFbCleared'), 'info');
    setTimeout(() => { const u = new URL(window.location.href); u.searchParams.delete('cfg'); window.location.href = u.toString(); }, 800);
  }
};

async function bootApp() {
  initPwaAndKioskHardware();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  try { await initDataLayer(); } catch (e) { console.error(e); }
  finally { document.getElementById('app-loader')?.classList.add('hidden'); applyRouteUI(); }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootApp);
else bootApp();
// === 코드 끝 ===
