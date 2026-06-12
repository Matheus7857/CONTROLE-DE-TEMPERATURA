/* ══════════════════════════════════════════════════════
   PAC TEMPERATURA v6 — Firebase Auth + Permissões + Mobile
   ══════════════════════════════════════════════════════ */

// ── FIREBASE CONFIG ───────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyDRudb6bvkn3g5q9cQErbgql8HPkqLPmTA",
  authDomain:        "fit-track-76263.firebaseapp.com",
  projectId:         "fit-track-76263",
  storageBucket:     "fit-track-76263.firebasestorage.app",
  messagingSenderId: "619423355890",
  appId:             "1:619423355890:web:a8643e9b65d944e99d116b",
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

// ── PERMISSÕES ────────────────────────────────────────
const PERM_LABELS = {
  novaLeitura:    'Nova Leitura',
  lancamentoLote: 'Lançamento em Lote',
  importar:       'Importar Planilha',
  exportar:       'Exportar CSV',
  imprimir:       'Imprimir PAC',
  excluir:        'Excluir leituras',
  admin:          'Administração',
};

const DEFAULT_PERMS = {
  admin:      { novaLeitura: true,  lancamentoLote: true,  importar: true,  exportar: true,  imprimir: true,  excluir: true,  admin: true  },
  supervisor: { novaLeitura: true,  lancamentoLote: true,  importar: false, exportar: true,  imprimir: true,  excluir: false, admin: false },
  operador:   { novaLeitura: true,  lancamentoLote: false, importar: false, exportar: false, imprimir: false, excluir: false, admin: false },
};

// ── ESTADO ────────────────────────────────────────────
let currentUser   = null;
let userProfile   = null;
let isRegistering = false; // evita race condition no onAuthStateChanged
let currentEquip  = 'refrig';
let currentYear   = new Date().getFullYear();
let currentMonth  = new Date().getMonth() + 1;
let localCache    = { entries: {}, supervisor: {} };
let fsUnsubscribe = null;
let editingUid    = null;

const EQUIP_CONFIG = {
  refrig: { label: 'Cont 1 - Refrigeração', ref: '0°C a 4°C', min: 0,   max: 4   },
  cong:   { label: 'Cont 2 - Congelamento', ref: '−18°C',      min: -25, max: -14 },
};

// ── HELPERS LOCALSTORAGE ──────────────────────────────
function lsKey(equip, year, month) {
  return `pac_backup_v2_${equip}_${year}_${String(month).padStart(2,'0')}`;
}

function lsSaveCurrent() {
  try { localStorage.setItem(lsKey(currentEquip, currentYear, currentMonth), JSON.stringify(localCache)); } catch(e) {}
}

function lsLoadCurrent() {
  try {
    const raw = localStorage.getItem(lsKey(currentEquip, currentYear, currentMonth));
    if (raw) { localCache = JSON.parse(raw); return true; }
  } catch(e) {}
  localCache = { entries: {}, supervisor: {} };
  return false;
}

// ── UTILIDADES ────────────────────────────────────────
function monthKey(equip, year, month) {
  return `${equip}_${year}-${String(month).padStart(2,'0')}`;
}

function padZ(n) { return String(n).padStart(2,'0'); }

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${padZ(d.getMonth()+1)}-${padZ(d.getDate())}`;
}

function currentPeriod() {
  const h = new Date().getHours();
  if (h >= 6  && h < 12) return 'manha';
  if (h >= 12 && h < 18) return 'tarde';
  return 'noite';
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function dateRange(fromStr, toStr) {
  const dates = [];
  const cur = new Date(fromStr + 'T00:00:00');
  const end = new Date(toStr   + 'T00:00:00');
  while (cur <= end) {
    dates.push(`${cur.getFullYear()}-${padZ(cur.getMonth()+1)}-${padZ(cur.getDate())}`);
    cur.setDate(cur.getDate()+1);
  }
  return dates;
}

function formatDateBR(ds) {
  if (!ds) return '';
  const [y, m, d] = ds.split('-');
  return `${d}/${m}/${y}`;
}

function tempClass(equip, val) {
  const v = parseFloat(val);
  if (isNaN(v)) return '';
  const cfg = EQUIP_CONFIG[equip];
  if (v >= cfg.min && v <= cfg.max) return 't-ok';
  if (equip === 'refrig') return (v > cfg.max && v <= cfg.max + 2) ? 't-warn' : 't-alarm';
  if (v > cfg.max) return 't-alarm';
  return 't-ok';
}

function setSyncStatus(state, label) {
  const el = document.getElementById('syncStatus');
  const lb = document.getElementById('syncLabel');
  if (el) el.className = 'sync-status ' + state;
  if (lb) lb.textContent = label;
}

function show(id) { const el = document.getElementById(id); if (el) el.style.display = ''; }
function hide(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

// ── PERMISSÕES ────────────────────────────────────────
function canDo(perm) {
  return !!(userProfile && userProfile.ativo && userProfile.permissoes && userProfile.permissoes[perm]);
}

function applyPermissions() {
  const showPerm = (id, perm) => {
    const el = document.getElementById(id);
    if (el) el.style.display = canDo(perm) ? '' : 'none';
  };
  showPerm('btnBulk',      'lancamentoLote');
  showPerm('btnTemplate',  'importar');
  showPerm('btnImport',    'importar');
  showPerm('btnExport',    'exportar');
  showPerm('btnPrint',     'imprimir');
  showPerm('btnAdminPanel','admin');

  const fab = document.getElementById('fabAdd');
  if (fab) fab.style.display = canDo('novaLeitura') ? 'flex' : 'none';

  const nameEl = document.getElementById('userName');
  const roleEl = document.getElementById('userRole');
  if (nameEl && userProfile) nameEl.textContent = userProfile.nome || '';
  if (roleEl && userProfile) roleEl.textContent = userProfile.cargo || '';
}

// ── AUTH FLOW ─────────────────────────────────────────
function showLoginScreen() {
  hide('app'); hide('pendingScreen');
  show('loginScreen');
  show('panelLogin'); hide('panelRegister');
  clearAuthError();
}

function showApp() {
  hide('loginScreen'); hide('pendingScreen');
  show('app');
  applyPermissions();
  subscribeMonth();
}

function showPendingScreen() {
  hide('loginScreen'); hide('app');
  show('pendingScreen');
}

function showAuthError(msg) {
  const el = document.getElementById('loginError');
  if (el) { el.textContent = msg; el.style.display = ''; }
}

function clearAuthError() {
  const el = document.getElementById('loginError');
  if (el) el.style.display = 'none';
}

async function doLogin() {
  const email = (document.getElementById('loginEmail')?.value || '').trim();
  const pass  =  document.getElementById('loginPassword')?.value || '';
  clearAuthError();
  if (!email || !pass) { showAuthError('Preencha e-mail e senha.'); return; }

  const btn = document.getElementById('btnLogin');
  if (btn) { btn.disabled = true; btn.textContent = 'Entrando...'; }

  try {
    await auth.signInWithEmailAndPassword(email, pass);
  } catch(e) {
    const msgs = {
      'auth/user-not-found':     'Usuário não encontrado.',
      'auth/wrong-password':     'Senha incorreta.',
      'auth/invalid-email':      'E-mail inválido.',
      'auth/invalid-credential': 'E-mail ou senha incorretos.',
      'auth/too-many-requests':  'Muitas tentativas. Tente novamente mais tarde.',
    };
    showAuthError(msgs[e.code] || 'Erro: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
  }
}

async function doRegister() {
  const nome  = (document.getElementById('regNome')?.value || '').trim();
  const email = (document.getElementById('regEmail')?.value || '').trim();
  const pass  =  document.getElementById('regPassword')?.value || '';
  clearAuthError();

  if (!nome)           { showAuthError('Informe seu nome.'); return; }
  if (!email)          { showAuthError('Informe seu e-mail.'); return; }
  if (pass.length < 6) { showAuthError('Senha deve ter pelo menos 6 caracteres.'); return; }

  const btn = document.getElementById('btnRegister');
  if (btn) { btn.disabled = true; btn.textContent = 'Criando conta...'; }

  isRegistering = true;
  try {
    // 1. Cria usuário Auth (agora está autenticado)
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    const uid  = cred.user.uid;

    // 2. Verifica se é o primeiro usuário (agora autenticado → Firestore permite)
    const snap    = await db.collection('usuarios').limit(1).get();
    const isFirst = snap.empty || (snap.size === 1 && snap.docs[0].id === uid);
    const cargo   = isFirst ? 'admin' : 'operador';

    // 3. Cria perfil no Firestore
    const perfil = {
      nome,
      email,
      cargo,
      ativo: isFirst,
      permissoes: { ...DEFAULT_PERMS[cargo] },
      criadoEm: firebase.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection('usuarios').doc(uid).set(perfil);

    // 4. Navega diretamente sem esperar o onAuthStateChanged
    currentUser  = cred.user;
    userProfile  = { ...perfil, ativo: isFirst };
    isRegistering = false;

    if (isFirst) {
      showApp();
    } else {
      showPendingScreen();
    }
  } catch(e) {
    isRegistering = false;
    const msgs = {
      'auth/email-already-in-use': 'Este e-mail já está cadastrado.',
      'auth/invalid-email':        'E-mail inválido.',
      'auth/weak-password':        'Senha muito fraca.',
    };
    showAuthError(msgs[e.code] || 'Erro: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Criar conta'; }
  }
}

async function doLogout() {
  if (fsUnsubscribe) { fsUnsubscribe(); fsUnsubscribe = null; }
  await auth.signOut();
}

function initAuth() {
  auth.onAuthStateChanged(async user => {
    if (isRegistering) return; // aguarda o doRegister terminar de escrever o perfil
    if (user) {
      currentUser = user;
      try {
        const doc = await db.collection('usuarios').doc(user.uid).get();
        userProfile = doc.exists ? doc.data() : null;
      } catch(e) {
        userProfile = null;
      }

      if (!userProfile) {
        showAuthError('Perfil não encontrado. Contate o administrador.');
        await auth.signOut();
        return;
      }

      if (!userProfile.ativo) {
        showPendingScreen();
      } else {
        showApp();
      }
    } else {
      currentUser = null;
      userProfile = null;
      if (fsUnsubscribe) { fsUnsubscribe(); fsUnsubscribe = null; }
      showLoginScreen();
    }
  });
}

// ── FIRESTORE DATA ────────────────────────────────────
function fsDocRef(equip, year, month) {
  return db.collection('pac_monitoramento').doc(monthKey(equip, year, month));
}

async function fsWrite() {
  setSyncStatus('syncing', 'Salvando...');
  try {
    await fsDocRef(currentEquip, currentYear, currentMonth).set(
      { entries: localCache.entries, supervisor: localCache.supervisor || {} }
    );
    lsSaveCurrent();
    setSyncStatus('synced', 'Salvo');
  } catch(e) {
    setSyncStatus('offline', 'Offline');
    lsSaveCurrent();
  }
}

function subscribeMonth() {
  if (fsUnsubscribe) { fsUnsubscribe(); fsUnsubscribe = null; }
  lsLoadCurrent();
  renderAll();
  setSyncStatus('syncing', 'Conectando...');

  fsUnsubscribe = fsDocRef(currentEquip, currentYear, currentMonth)
    .onSnapshot(snap => {
      if (snap.exists) {
        const d = snap.data();
        localCache.entries    = d.entries    || {};
        localCache.supervisor = d.supervisor || {};
        lsSaveCurrent();
      }
      renderAll();
      setSyncStatus('synced', 'Sincronizado');
    }, () => {
      setSyncStatus('offline', 'Offline');
      renderAll();
    });
}

async function saveEntry(dateStr, entry) {
  localCache.entries[dateStr] = entry;
  lsSaveCurrent();
  renderAll();
  await fsWrite();
}

async function deleteEntry(dateStr) {
  delete localCache.entries[dateStr];
  lsSaveCurrent();
  renderAll();
  await fsWrite();
}

function getEntryForDate(ds) {
  const [y, m] = ds.split('-');
  if (parseInt(y) === currentYear && parseInt(m) === currentMonth) {
    return localCache.entries[ds] || null;
  }
  try {
    const raw = localStorage.getItem(lsKey(currentEquip, parseInt(y), parseInt(m)));
    if (raw) {
      const obj = JSON.parse(raw);
      return obj.entries?.[ds] || null;
    }
  } catch(e) {}
  return null;
}

// ── RENDER ────────────────────────────────────────────
function renderAll() {
  renderMonthLabel();
  renderTable();
}

function renderMonthLabel() {
  const names = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const el = document.getElementById('monthLabel');
  if (el) el.textContent = `${names[currentMonth-1]} ${currentYear}`;

  const cfg = EQUIP_CONFIG[currentEquip];
  const rl  = document.getElementById('refTempLabel');
  const el2 = document.getElementById('equipLabel');
  if (rl)  rl.textContent  = cfg.ref;
  if (el2) el2.textContent = cfg.label;
}

function renderTable() {
  const tbody = document.getElementById('pacBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const todayStr = today();
  const days     = daysInMonth(currentYear, currentMonth);
  const canDel   = canDo('excluir');
  const canEdit  = canDo('novaLeitura');

  for (let d = 1; d <= days; d++) {
    const ds    = `${currentYear}-${padZ(currentMonth)}-${padZ(d)}`;
    const dt    = new Date(ds + 'T00:00:00');
    const wd    = dt.getDay();
    const entry = localCache.entries[ds] || null;
    const dow   = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][wd];

    const tr = document.createElement('tr');

    // Coluna Data
    const tdDate = document.createElement('td');
    tdDate.className = 'td-date' +
      (ds === todayStr    ? ' is-today'   : '') +
      (wd === 0 || wd === 6 ? ' is-weekend' : '');
    tdDate.innerHTML = `<span class="day-num">${padZ(d)}</span> <span style="font-size:.72rem;color:#90A4AE">${dow}</span>`;
    tr.appendChild(tdDate);

    // Turnos
    ['manha','tarde','noite'].forEach(t => {
      const hora = entry?.[t]?.hora || '';
      const temp = entry?.[t]?.temp;

      const tdH = document.createElement('td');
      tdH.textContent = hora || '—';
      tr.appendChild(tdH);

      const tdT = document.createElement('td');
      tdT.className = 'td-temp';
      if (temp !== undefined && temp !== '') {
        const cls = tempClass(currentEquip, temp);
        tdT.className += ' ' + cls;
        tdT.textContent = parseFloat(temp).toFixed(1) + '°';
      } else {
        const filled = !!hora;
        tdT.innerHTML = `<span class="turn-badge ${filled ? 'filled' : 'empty'}">${filled ? 'OK' : '—'}</span>`;
      }
      tr.appendChild(tdT);
    });

    // Responsável
    const tdResp = document.createElement('td');
    tdResp.className = 'hide-mobile';
    tdResp.textContent = entry?.responsavel || '';
    tr.appendChild(tdResp);

    // Ações
    const tdAct  = document.createElement('td');
    tdAct.className = 'no-print';
    const actDiv = document.createElement('div');
    actDiv.className = 'actions-cell';

    if (canEdit) {
      const btnE = document.createElement('button');
      btnE.className   = 'btn-table btn-edit';
      btnE.textContent = entry ? '✏ Editar' : '+ Incluir';
      btnE.addEventListener('click', () => startEdit(ds));
      actDiv.appendChild(btnE);
    }

    if (canDel && entry) {
      const btnD = document.createElement('button');
      btnD.className   = 'btn-table btn-del';
      btnD.textContent = '🗑';
      btnD.title = 'Excluir';
      btnD.addEventListener('click', () => {
        if (confirm(`Excluir leitura de ${formatDateBR(ds)}?`)) deleteEntry(ds);
      });
      actDiv.appendChild(btnD);
    }

    tdAct.appendChild(actDiv);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }
}

// ── FORMULÁRIO INDIVIDUAL ─────────────────────────────
function startEdit(dateStr) {
  if (!canDo('novaLeitura')) return;
  const entry   = localCache.entries[dateStr] || null;
  const isToday = dateStr === today();

  document.getElementById('fDate').value = dateStr;
  document.getElementById('fResp').value = entry?.responsavel || (userProfile?.nome || '');
  document.getElementById('fDate').readOnly = false;

  ['manha','tarde','noite'].forEach(t => {
    const CAP = t.charAt(0).toUpperCase() + t.slice(1);
    const e   = entry?.[t] || {};
    document.getElementById(`f${CAP}Hora`).value = e.hora || '';
    document.getElementById(`f${CAP}Temp`).value = (e.temp !== undefined && e.temp !== '') ? e.temp : '';
  });

  if (isToday) {
    const p   = currentPeriod();
    const CAP = p.charAt(0).toUpperCase() + p.slice(1);
    const el  = document.getElementById(`f${CAP}Hora`);
    if (el && !el.value) {
      const now = new Date();
      el.value  = `${padZ(now.getHours())}:${padZ(now.getMinutes())}`;
    }
  }

  document.getElementById('formTitle').textContent = entry
    ? `Editar — ${formatDateBR(dateStr)}`
    : `Nova leitura — ${formatDateBR(dateStr)}`;
  document.getElementById('entryForm').style.display = '';
  document.getElementById('entryForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function startEditBlank() {
  if (!canDo('novaLeitura')) return;
  const t = today();
  const [y, m] = t.split('-').map(Number);
  const isCurrent = (y === currentYear && m === currentMonth);
  const defaultDate = isCurrent ? t : `${currentYear}-${padZ(currentMonth)}-01`;

  document.getElementById('fDate').value = defaultDate;
  document.getElementById('fResp').value = userProfile?.nome || '';
  ['Manha','Tarde','Noite'].forEach(x => {
    document.getElementById(`f${x}Hora`).value = '';
    document.getElementById(`f${x}Temp`).value = '';
  });

  if (isCurrent) {
    const p   = currentPeriod();
    const CAP = p.charAt(0).toUpperCase() + p.slice(1);
    const now = new Date();
    document.getElementById(`f${CAP}Hora`).value = `${padZ(now.getHours())}:${padZ(now.getMinutes())}`;
  }

  document.getElementById('formTitle').textContent = 'Nova leitura';
  document.getElementById('entryForm').style.display = '';
  document.getElementById('entryForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeForm() {
  document.getElementById('entryForm').style.display = 'none';
}

async function doSave() {
  const dateStr = document.getElementById('fDate').value;
  if (!dateStr) { alert('Selecione uma data.'); return; }

  const entry = {
    responsavel: document.getElementById('fResp').value.trim(),
    manha: { hora: document.getElementById('fManhaHora').value, temp: document.getElementById('fManhaTemp').value },
    tarde: { hora: document.getElementById('fTardeHora').value, temp: document.getElementById('fTardeTemp').value },
    noite: { hora: document.getElementById('fNoiteHora').value, temp: document.getElementById('fNoiteTemp').value },
    atualizadoEm:  new Date().toISOString(),
    atualizadoPor: userProfile?.nome || '',
  };

  const [ey, em] = dateStr.split('-').map(Number);
  if (ey !== currentYear || em !== currentMonth) {
    const key = lsKey(currentEquip, ey, em);
    let cache = { entries: {}, supervisor: {} };
    try { const r = localStorage.getItem(key); if (r) cache = JSON.parse(r); } catch(e) {}
    cache.entries[dateStr] = entry;
    localStorage.setItem(key, JSON.stringify(cache));
    await db.collection('pac_monitoramento').doc(monthKey(currentEquip, ey, em)).set({ entries: cache.entries }, { merge: false });
    closeForm();
    return;
  }

  await saveEntry(dateStr, entry);
  closeForm();
}

// ── MODAL LANÇAMENTO EM LOTE ──────────────────────────
function openBulkModal() {
  if (!canDo('lancamentoLote')) return;
  const y = currentYear, m = currentMonth;
  const days = daysInMonth(y, m);
  document.getElementById('qDateFrom').value = `${y}-${padZ(m)}-01`;
  document.getElementById('qDateTo').value   = `${y}-${padZ(m)}-${padZ(days)}`;
  document.getElementById('bulkModalTitle').textContent = `Lançamento em Lote — ${EQUIP_CONFIG[currentEquip].label}`;
  buildBulkRows(`${y}-${padZ(m)}-01`, `${y}-${padZ(m)}-${padZ(days)}`);
  document.getElementById('bulkModal').style.display = 'flex';
}

function buildBulkRows(fromStr, toStr) {
  const dates = dateRange(fromStr, toStr);
  const tbody = document.getElementById('bulkBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  let lastMonth = '';
  dates.forEach(ds => {
    const [y, m] = ds.split('-');
    const mLabel = `${['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][parseInt(m)-1]} ${y}`;

    if (mLabel !== lastMonth) {
      lastMonth = mLabel;
      const sepTr = document.createElement('tr');
      const sepTd = document.createElement('td');
      sepTd.colSpan  = 9;
      sepTd.className = 'td-month-sep';
      sepTd.textContent = mLabel;
      sepTr.appendChild(sepTd);
      tbody.appendChild(sepTr);
    }

    const entry = getEntryForDate(ds) || null;
    const dt    = new Date(ds + 'T00:00:00');
    const wd    = dt.getDay();
    const dow   = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][wd];

    const tr = document.createElement('tr');
    tr.dataset.date = ds;

    const tdDate = document.createElement('td');
    tdDate.style.cssText = 'padding:4px 8px;font-weight:700;white-space:nowrap';
    tdDate.innerHTML = `${formatDateBR(ds)} <span style="font-size:.7rem;color:#90A4AE">${dow}</span>`;
    tr.appendChild(tdDate);

    ['manha','tarde','noite'].forEach(t => {
      const e = entry?.[t] || {};

      const tdH = document.createElement('td');
      const inH = document.createElement('input');
      inH.type  = 'time';
      inH.value = e.hora || '';
      inH.dataset.field = `${ds}|${t}|hora`;
      tdH.appendChild(inH);
      tr.appendChild(tdH);

      const tdT = document.createElement('td');
      const inT = document.createElement('input');
      inT.type        = 'number';
      inT.step        = '0.1';
      inT.placeholder = '°C';
      inT.value       = (e.temp !== undefined && e.temp !== '') ? e.temp : '';
      inT.dataset.field = `${ds}|${t}|temp`;
      inT.className   = tempClass(currentEquip, e.temp);
      inT.addEventListener('input', () => { inT.className = tempClass(currentEquip, inT.value); });
      tdT.appendChild(inT);
      tr.appendChild(tdT);
    });

    const tdResp = document.createElement('td');
    const inResp = document.createElement('input');
    inResp.type        = 'text';
    inResp.placeholder = 'Responsável';
    inResp.value       = entry?.responsavel || '';
    inResp.dataset.field = `${ds}|resp`;
    tdResp.appendChild(inResp);
    tr.appendChild(tdResp);

    const tdCl  = document.createElement('td');
    const btnCl = document.createElement('button');
    btnCl.className   = 'btn-bulk-clear';
    btnCl.textContent = '✕';
    btnCl.title = 'Limpar linha';
    btnCl.addEventListener('click', () => {
      tr.querySelectorAll('input').forEach(i => { i.value = ''; i.className = ''; });
    });
    tdCl.appendChild(btnCl);
    tr.appendChild(tdCl);

    tbody.appendChild(tr);
  });
}

async function saveBulkEntries() {
  const rows = document.querySelectorAll('#bulkBody tr[data-date]');
  if (!rows.length) { alert('Nenhuma linha para salvar.'); return; }

  const btn = document.getElementById('btnBulkSave');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

  const byMonth = {};
  rows.forEach(tr => {
    const ds = tr.dataset.date;
    const [y, m] = ds.split('-');
    const mk = monthKey(currentEquip, parseInt(y), parseInt(m));
    if (!byMonth[mk]) byMonth[mk] = { year: parseInt(y), month: parseInt(m), entries: {} };

    const get = field => tr.querySelector(`[data-field="${field}"]`)?.value || '';
    const manhaH = get(`${ds}|manha|hora`), manhaT = get(`${ds}|manha|temp`);
    const tardeH = get(`${ds}|tarde|hora`), tardeT = get(`${ds}|tarde|temp`);
    const noiteH = get(`${ds}|noite|hora`), noiteT = get(`${ds}|noite|temp`);
    const resp   = get(`${ds}|resp`);

    const hasData = manhaH || tardeH || noiteH || manhaT || tardeT || noiteT;
    if (!hasData) return;

    byMonth[mk].entries[ds] = {
      responsavel: resp,
      manha: { hora: manhaH, temp: manhaT },
      tarde: { hora: tardeH, temp: tardeT },
      noite: { hora: noiteH, temp: noiteT },
      atualizadoEm:  new Date().toISOString(),
      atualizadoPor: userProfile?.nome || '',
    };
  });

  try {
    for (const [mk, data] of Object.entries(byMonth)) {
      const { year, month, entries } = data;
      const key   = lsKey(currentEquip, year, month);
      let cache   = { entries: {}, supervisor: {} };
      try { const r = localStorage.getItem(key); if (r) cache = JSON.parse(r); } catch(e) {}
      cache.entries = { ...cache.entries, ...entries };

      if (year === currentYear && month === currentMonth) {
        localCache.entries    = cache.entries;
        localCache.supervisor = cache.supervisor;
      }

      localStorage.setItem(key, JSON.stringify(cache));
      await db.collection('pac_monitoramento').doc(mk).set({ entries: cache.entries });
    }

    document.getElementById('bulkModal').style.display = 'none';
    renderAll();
    setSyncStatus('synced', 'Salvo');
  } catch(e) {
    alert('Erro ao salvar: ' + e.message);
    setSyncStatus('offline', 'Offline');
  }

  if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar Tudo'; }
}

// ── CSV ───────────────────────────────────────────────
function downloadTemplate() {
  if (!canDo('importar')) return;
  const cfg  = EQUIP_CONFIG[currentEquip];
  const y = currentYear, m = currentMonth;
  const days = daysInMonth(y, m);

  let csv = `PAC - Controle de Temperatura\nEquipamento;${cfg.label}\nReferência;${cfg.ref}\nPeríodo;${padZ(m)}/${y}\n\n`;
  csv += `Data;Manhã - Hora;Manhã - Temp (°C);Tarde - Hora;Tarde - Temp (°C);Noite - Hora;Noite - Temp (°C);Responsável\n`;

  for (let d = 1; d <= days; d++) {
    const ds = `${y}-${padZ(m)}-${padZ(d)}`;
    const e  = localCache.entries[ds];
    csv += [
      formatDateBR(ds),
      e?.manha?.hora||'', e?.manha?.temp !== undefined ? e.manha.temp : '',
      e?.tarde?.hora||'', e?.tarde?.temp !== undefined ? e.tarde.temp : '',
      e?.noite?.hora||'', e?.noite?.temp !== undefined ? e.noite.temp : '',
      e?.responsavel||'',
    ].join(';') + '\n';
  }

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `PAC_Modelo_${currentEquip}_${y}-${padZ(m)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function importCSV(file) {
  if (!canDo('importar')) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      let text = ev.target.result;
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const sep   = text.includes(';') ? ';' : ',';
      const lines = text.split('\n').map(l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, '')));

      let headerIdx = -1;
      lines.forEach((row, i) => { if (row.some(c => /^data$/i.test(c))) headerIdx = i; });
      if (headerIdx < 0) { alert('Formato inválido. Baixe o modelo primeiro.'); return; }

      const byMonth = {};
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const row = lines[i];
        if (!row[0] || !/\d{2}\/\d{2}\/\d{4}/.test(row[0])) continue;
        const [d, m, y] = row[0].split('/');
        const ds  = `${y}-${m}-${d}`;
        const mk  = monthKey(currentEquip, parseInt(y), parseInt(m));
        const lk  = lsKey(currentEquip, parseInt(y), parseInt(m));

        if (!byMonth[mk]) {
          let cache = { entries: {}, supervisor: {} };
          try { const r = localStorage.getItem(lk); if (r) cache = JSON.parse(r); } catch(e) {}
          byMonth[mk] = { year: parseInt(y), month: parseInt(m), lk, cache };
        }

        const hasData = row.slice(1,7).some(v => v !== '');
        if (!hasData) continue;

        byMonth[mk].cache.entries[ds] = {
          manha:       { hora: row[1]||'', temp: row[2] },
          tarde:       { hora: row[3]||'', temp: row[4] },
          noite:       { hora: row[5]||'', temp: row[6] },
          responsavel: row[7]||'',
          atualizadoEm:  new Date().toISOString(),
          atualizadoPor: userProfile?.nome || 'Importação',
        };
      }

      for (const [mk, data] of Object.entries(byMonth)) {
        localStorage.setItem(data.lk, JSON.stringify(data.cache));
        await db.collection('pac_monitoramento').doc(mk).set({ entries: data.cache.entries });
        if (data.year === currentYear && data.month === currentMonth)
          localCache.entries = data.cache.entries;
      }

      renderAll();
      alert('Importação concluída!');
    } catch(err) {
      alert('Erro na importação: ' + err.message);
    }
  };
  reader.readAsText(file, 'UTF-8');
}

// ── IMPRIMIR ──────────────────────────────────────────
function printPAC() {
  if (!canDo('imprimir')) return;
  const cfg  = EQUIP_CONFIG[currentEquip];
  const y = currentYear, m = currentMonth;
  const days  = daysInMonth(y, m);
  const names = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  let rows = '';
  for (let d = 1; d <= days; d++) {
    const ds  = `${y}-${padZ(m)}-${padZ(d)}`;
    const e   = localCache.entries[ds];
    const dt  = new Date(ds + 'T00:00:00');
    const dow = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][dt.getDay()];
    const bg  = (dt.getDay() === 0 || dt.getDay() === 6) ? '#F5F0FF' : '#fff';

    const cell = (h, t) => {
      const tc = tempClass(currentEquip, t);
      const col = tc === 't-ok' ? '#1B5E20' : tc === 't-warn' ? '#E65100' : tc === 't-alarm' ? '#B71C1C' : '#333';
      return `<td style="border:1px solid #ccc;padding:4px 6px">${h||''}</td><td style="border:1px solid #ccc;padding:4px 6px;font-weight:bold;color:${col}">${t!==undefined&&t!==''?parseFloat(t).toFixed(1)+'°':''}</td>`;
    };

    rows += `<tr style="background:${bg}"><td style="border:1px solid #ccc;padding:4px 8px;font-weight:700">${padZ(d)} ${dow}</td>${cell(e?.manha?.hora,e?.manha?.temp)}${cell(e?.tarde?.hora,e?.tarde?.temp)}${cell(e?.noite?.hora,e?.noite?.temp)}<td style="border:1px solid #ccc;padding:4px 6px">${e?.responsavel||''}</td></tr>`;
  }

  document.getElementById('printView').innerHTML = `
    <div style="font-family:Arial,sans-serif;max-width:210mm;margin:0 auto;padding:10px">
      <div style="text-align:center;margin-bottom:12px">
        <h2 style="font-size:13pt;margin:0">REI DA MUSSARELA E DO PÃO DE QUEIJO</h2>
        <h3 style="font-size:11pt;margin:4px 0">PAC — CONTROLE DE TEMPERATURA</h3>
        <p style="font-size:9pt;color:#555;margin:2px 0">${cfg.label} · Ref: ${cfg.ref} · ${names[m-1]} ${y}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:9pt">
        <thead>
          <tr style="background:#1565C0;color:#fff">
            <th rowspan="2" style="padding:5px;border:1px solid #333">Data</th>
            <th colspan="2" style="padding:5px;border:1px solid #333">Manhã</th>
            <th colspan="2" style="padding:5px;border:1px solid #333">Tarde</th>
            <th colspan="2" style="padding:5px;border:1px solid #333">Noite</th>
            <th rowspan="2" style="padding:5px;border:1px solid #333">Responsável</th>
          </tr>
          <tr style="background:#1976D2;color:#fff">
            <th style="padding:4px;border:1px solid #333">Hora</th><th style="padding:4px;border:1px solid #333">°C</th>
            <th style="padding:4px;border:1px solid #333">Hora</th><th style="padding:4px;border:1px solid #333">°C</th>
            <th style="padding:4px;border:1px solid #333">Hora</th><th style="padding:4px;border:1px solid #333">°C</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:20px;display:flex;gap:40px;align-items:flex-end">
        <div><p style="font-size:8pt">Supervisor:</p><div style="border-bottom:1px solid #333;width:200px;height:24px"></div></div>
        <div><p style="font-size:8pt">Assinatura:</p><div style="border-bottom:1px solid #333;width:150px;height:24px"></div></div>
        <div><p style="font-size:8pt">Data: ___/___/______</p></div>
      </div>
    </div>`;

  window.print();
}

function exportCSV() {
  if (!canDo('exportar')) return;
  const cfg = EQUIP_CONFIG[currentEquip];
  const y = currentYear, m = currentMonth;
  let csv = `Equipamento;${cfg.label}\nReferência;${cfg.ref}\nPeríodo;${padZ(m)}/${y}\n\n`;
  csv += `Data;Manhã - Hora;Manhã °C;Tarde - Hora;Tarde °C;Noite - Hora;Noite °C;Responsável\n`;

  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const ds = `${y}-${padZ(m)}-${padZ(d)}`;
    const e  = localCache.entries[ds];
    csv += [
      formatDateBR(ds),
      e?.manha?.hora||'', e?.manha?.temp||'',
      e?.tarde?.hora||'', e?.tarde?.temp||'',
      e?.noite?.hora||'', e?.noite?.temp||'',
      e?.responsavel||'',
    ].join(';') + '\n';
  }

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `PAC_${currentEquip}_${y}-${padZ(m)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// ── PAINEL ADMIN ──────────────────────────────────────
async function openAdminPanel() {
  if (!canDo('admin')) return;
  document.getElementById('adminModal').style.display = 'flex';
  await loadUsers();
}

async function loadUsers() {
  const tbody = document.getElementById('usersBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#90A4AE">Carregando...</td></tr>';

  try {
    const snap = await db.collection('usuarios').get();
    tbody.innerHTML = '';

    if (snap.empty) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#90A4AE">Nenhum usuário.</td></tr>';
      return;
    }

    snap.forEach(doc => {
      const uid  = doc.id;
      const data = doc.data();
      const tr   = document.createElement('tr');
      const status = data.ativo ? 'ativo' : 'pendente';
      const statusLabel = data.ativo ? '✓ Ativo' : '⏳ Pendente';
      const isMe = uid === currentUser?.uid;

      tr.innerHTML = `
        <td style="font-weight:600">${data.nome||'—'}</td>
        <td style="font-size:.8rem;color:#546E7A">${data.email||'—'}</td>
        <td><span class="badge-role ${data.cargo}">${data.cargo}</span></td>
        <td><span class="badge-status ${status}">${statusLabel}</span></td>
        <td>
          <div class="actions-cell">
            <button class="btn-table btn-edit" data-uid="${uid}">✏ Editar</button>
            ${!isMe ? `<button class="btn-table btn-del" data-uid="${uid}" data-active="${data.ativo}">${data.ativo ? '🔒 Desativar' : '🔓 Ativar'}</button>` : ''}
          </div>
        </td>`;

      tr.querySelector(`[data-uid="${uid}"].btn-edit`)
        ?.addEventListener('click', () => openUserModal(uid, data));

      tr.querySelector(`[data-uid="${uid}"].btn-del`)
        ?.addEventListener('click', () => toggleUserActive(uid, data));

      tbody.appendChild(tr);
    });
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:red;padding:12px">${e.message}</td></tr>`;
  }
}

async function toggleUserActive(uid, data) {
  const newState = !data.ativo;
  if (!confirm(`${newState ? 'Ativar' : 'Desativar'} o usuário "${data.nome}"?`)) return;
  try {
    await db.collection('usuarios').doc(uid).update({ ativo: newState });
    await loadUsers();
  } catch(e) {
    alert('Erro: ' + e.message);
  }
}

function openUserModal(uid, data) {
  editingUid = uid || null;
  const isNew = !uid;

  document.getElementById('userModalTitle').textContent = isNew ? 'Novo Usuário' : 'Editar Usuário';
  document.getElementById('uNome').value     = data?.nome  || '';
  document.getElementById('uEmail').value    = data?.email || '';
  document.getElementById('uPassword').value = '';
  document.getElementById('uCargo').value    = data?.cargo || 'operador';

  document.getElementById('uEmailGroup').style.display    = isNew ? '' : 'none';
  document.getElementById('uPasswordGroup').style.display = isNew ? '' : 'none';

  buildPermsGrid(data?.permissoes || DEFAULT_PERMS[data?.cargo || 'operador']);
  document.getElementById('userModal').style.display = 'flex';

  document.getElementById('uCargo').onchange = () => {
    buildPermsGrid(DEFAULT_PERMS[document.getElementById('uCargo').value]);
  };
}

function buildPermsGrid(currentPerms) {
  const grid = document.getElementById('permsGrid');
  grid.innerHTML = '';
  Object.entries(PERM_LABELS).forEach(([key, label]) => {
    const item = document.createElement('label');
    item.className = 'perm-item';
    const cb  = document.createElement('input');
    cb.type   = 'checkbox';
    cb.name   = key;
    cb.checked = !!(currentPerms && currentPerms[key]);
    const span = document.createElement('span');
    span.className   = 'perm-label';
    span.textContent = label;
    item.appendChild(cb);
    item.appendChild(span);
    grid.appendChild(item);
  });
}

function getPermsFromGrid() {
  const perms = {};
  Object.keys(PERM_LABELS).forEach(key => {
    const cb = document.querySelector(`#permsGrid input[name="${key}"]`);
    perms[key] = cb ? cb.checked : false;
  });
  return perms;
}

async function saveUser() {
  const nome  = document.getElementById('uNome').value.trim();
  const cargo = document.getElementById('uCargo').value;
  const perms = getPermsFromGrid();
  const isNew = !editingUid;

  if (!nome) { alert('Informe o nome.'); return; }

  const btn = document.getElementById('btnSaveUser');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

  try {
    if (isNew) {
      const email = document.getElementById('uEmail').value.trim();
      const pass  = document.getElementById('uPassword').value;
      if (!email) { alert('Informe o e-mail.'); return; }
      if (pass.length < 6) { alert('Senha: mínimo 6 caracteres.'); return; }

      // REST API — cria usuário sem fazer logout do admin atual
      const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${firebaseConfig.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: pass, returnSecureToken: false }),
        }
      );

      if (!res.ok) {
        const err = await res.json();
        const msgs = { 'EMAIL_EXISTS': 'E-mail já cadastrado.' };
        throw new Error(msgs[err.error.message] || err.error.message);
      }

      const resData = await res.json();
      await db.collection('usuarios').doc(resData.localId).set({
        nome, email, cargo,
        ativo: true,
        permissoes: perms,
        criadoEm: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await db.collection('usuarios').doc(editingUid).update({ nome, cargo, permissoes: perms });
    }

    document.getElementById('userModal').style.display = 'none';
    await loadUsers();
    alert(isNew ? 'Usuário criado!' : 'Usuário atualizado!');
  } catch(e) {
    alert('Erro: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }
  }
}

// ── NAVEGAÇÃO ─────────────────────────────────────────
function changeMonth(delta) {
  currentMonth += delta;
  if (currentMonth > 12) { currentMonth = 1;  currentYear++; }
  if (currentMonth < 1)  { currentMonth = 12; currentYear--; }
  subscribeMonth();
}

function changeEquip(equip) {
  currentEquip = equip;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.equip === equip));
  const now = new Date();
  currentYear  = now.getFullYear();
  currentMonth = now.getMonth() + 1;
  closeForm();
  subscribeMonth();
}

// ── EVENTOS ───────────────────────────────────────────
function setupBulkModalEvents() {
  document.getElementById('btnBulkSave')   ?.addEventListener('click', saveBulkEntries);
  document.getElementById('btnBulkCancel') ?.addEventListener('click', () => { document.getElementById('bulkModal').style.display = 'none'; });
  document.getElementById('bulkModalClose')?.addEventListener('click', () => { document.getElementById('bulkModal').style.display = 'none'; });

  document.getElementById('btnSetRange')?.addEventListener('click', () => {
    const from = document.getElementById('qDateFrom').value;
    const to   = document.getElementById('qDateTo').value;
    if (!from || !to || from > to) { alert('Período inválido.'); return; }
    buildBulkRows(from, to);
  });

  document.getElementById('btnFillHoras')?.addEventListener('click', () => {
    const mH = document.getElementById('qManhaHora').value;
    const tH = document.getElementById('qTardeHora').value;
    const nH = document.getElementById('qNoiteHora').value;
    document.querySelectorAll('#bulkBody tr[data-date]').forEach(tr => {
      const ds = tr.dataset.date;
      if (mH) { const el = tr.querySelector(`[data-field="${ds}|manha|hora"]`); if (el && !el.value) el.value = mH; }
      if (tH) { const el = tr.querySelector(`[data-field="${ds}|tarde|hora"]`); if (el && !el.value) el.value = tH; }
      if (nH) { const el = tr.querySelector(`[data-field="${ds}|noite|hora"]`); if (el && !el.value) el.value = nH; }
    });
  });

  document.getElementById('btnFillResp')?.addEventListener('click', () => {
    const r = document.getElementById('qResp').value;
    if (!r) return;
    document.querySelectorAll('#bulkBody [data-field$="|resp"]').forEach(el => { if (!el.value) el.value = r; });
  });
}

function setupAdminEvents() {
  document.getElementById('btnAdminPanel') ?.addEventListener('click', openAdminPanel);
  document.getElementById('adminModalClose')?.addEventListener('click', () => { document.getElementById('adminModal').style.display = 'none'; });
  document.getElementById('btnNewUser')    ?.addEventListener('click', () => openUserModal(null, null));
  document.getElementById('btnSaveUser')   ?.addEventListener('click', saveUser);
  document.getElementById('btnCancelUser') ?.addEventListener('click', () => { document.getElementById('userModal').style.display = 'none'; });
  document.getElementById('userModalClose')?.addEventListener('click', () => { document.getElementById('userModal').style.display = 'none'; });

  document.getElementById('adminModal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('adminModal')) document.getElementById('adminModal').style.display = 'none';
  });
  document.getElementById('userModal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('userModal')) document.getElementById('userModal').style.display = 'none';
  });
}

function setupLoginEvents() {
  document.getElementById('btnLogin')       ?.addEventListener('click', doLogin);
  document.getElementById('btnRegister')    ?.addEventListener('click', doRegister);
  document.getElementById('btnLogout')      ?.addEventListener('click', doLogout);
  document.getElementById('btnLogoutPending')?.addEventListener('click', doLogout);
  document.getElementById('btnGoRegister')  ?.addEventListener('click', () => { clearAuthError(); hide('panelLogin'); show('panelRegister'); });
  document.getElementById('btnGoLogin')     ?.addEventListener('click', () => { clearAuthError(); hide('panelRegister'); show('panelLogin'); });
  document.getElementById('loginPassword')  ?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('regPassword')    ?.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
}

function setupAppEvents() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => changeEquip(tab.dataset.equip));
  });

  document.getElementById('prevMonth')     ?.addEventListener('click', () => changeMonth(-1));
  document.getElementById('nextMonth')     ?.addEventListener('click', () => changeMonth(+1));
  document.getElementById('btnBulk')       ?.addEventListener('click', openBulkModal);
  document.getElementById('btnTemplate')   ?.addEventListener('click', downloadTemplate);
  document.getElementById('btnImport')     ?.addEventListener('click', () => document.getElementById('csvFileInput').click());
  document.getElementById('btnPrint')      ?.addEventListener('click', printPAC);
  document.getElementById('btnExport')     ?.addEventListener('click', exportCSV);

  document.getElementById('csvFileInput')?.addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) { importCSV(f); e.target.value = ''; }
  });

  document.getElementById('fabAdd')         ?.addEventListener('click', startEditBlank);
  document.getElementById('btnCancel')       ?.addEventListener('click', closeForm);
  document.getElementById('btnCancelBottom') ?.addEventListener('click', closeForm);
  document.getElementById('btnSave')         ?.addEventListener('click', doSave);

  document.getElementById('bulkModal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('bulkModal')) document.getElementById('bulkModal').style.display = 'none';
  });
}

// ── INIT ──────────────────────────────────────────────
function init() {
  setupLoginEvents();
  setupAppEvents();
  setupBulkModalEvents();
  setupAdminEvents();
  initAuth();
}

init();
