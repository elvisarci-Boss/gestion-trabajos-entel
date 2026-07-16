/* ===== SPSA Dashboard v2 — app.js =====
   Replica el formato del dashboard original: tabla con edición inline (técnico/estado/
   entregables/guías), Alertas Próximas, Sectorización (mapa real), Carga de Técnicos con
   estadísticas, Notificaciones, Programaciones (vista semanal) y Usuarios con roles. */

const STORAGE_KEY = 'spsa_v2_state';
const USERS_KEY   = 'spsa_v2_users'; // ← Clave SEPARADA solo para usuarios
                                       //   NO se borra al limpiar spsa_v2_state

// Usuarios que siempre existen aunque se limpie todo
const DEFAULT_USERS = [
  { nombre:'Administrador', correo:'admin@spsa.com', pass:'admin123', rol:'Administrador' }
];

// ── Carga usuarios desde su propia clave de localStorage ──
function loadUsers(){
  // 1) Intentar clave nueva dedicada
  try {
    const u = JSON.parse(localStorage.getItem(USERS_KEY));
    if(Array.isArray(u) && u.length > 0) return u;
  } catch(e){}

  // 2) Migración: si existen en el estado viejo, moverlos a la clave nueva
  try {
    const old = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if(old?.usuarios?.length > 0){
      localStorage.setItem(USERS_KEY, JSON.stringify(old.usuarios));
      console.log('[Usuarios] Migración completada:', old.usuarios.map(u=>u.correo));
      return old.usuarios;
    }
  } catch(e){}

  // 3) Fallback: usuarios por defecto
  return [...DEFAULT_USERS];
}

// ── Guarda usuarios en su propia clave ──
function saveUsers(){
  localStorage.setItem(USERS_KEY, JSON.stringify(state.usuarios));
}

// Campos adicionales que aparecen en el correo de asignación
const CUSTOM_FIELDS = [
  { key: 'bw',        label: 'BW (Mbps)',   type: 'text' },
  { key: 'cambioCpe', label: 'Cambio CPE',  type: 'text' },
];

// ── Reglas de bloqueo de guías según trabajo a realizar ──
const TRABAJO_GUIA_RULES = {
  'Desinstalación de Equipos': { blockInst: true,  blockDes: false },
  'Reubicación':               { blockInst: true,  blockDes: true  },
  'Adición de Equipo':         { blockInst: false, blockDes: true  },
  // UpGrade, Cambio de Equipo: ningún campo bloqueado (ambas guías aplican)
};

// Aplica auto-relleno con "No Aplica" y marca qué campos fueron auto-llenados
function applyGuiaRules(key, trabajoRealizar) {
  state.overrides[key] = state.overrides[key] || {};
  const ov = state.overrides[key];
  const rule = TRABAJO_GUIA_RULES[trabajoRealizar];

  // Limpiar auto-rellenos anteriores (solo los que fueron auto-generados)
  if (ov._guiaInstAuto) { ov.guiaInstN = ''; ov.guiaInstS = ''; ov._guiaInstAuto = false; }
  if (ov._guiaDesAuto)  { ov.guiaDesN  = ''; ov.guiaDesS  = ''; ov._guiaDesAuto  = false; }

  if (!rule) return; // Sin regla: los campos quedan libres

  if (rule.blockInst) {
    ov.guiaInstN = 'No Aplica';
    ov.guiaInstS = 'No Aplica';
    ov._guiaInstAuto = true;
  }
  if (rule.blockDes) {
    ov.guiaDesN = 'No Aplica';
    ov.guiaDesS = 'No Aplica';
    ov._guiaDesAuto = true;
  }
}

// Calcula el % de entregables considerando guías parciales
// Acta(1/3) + Guía(1/3 completo si ambas, 1/6 si solo una) + Informe(1/3)
function calcEntregPct(r) {
  const acta    = r.acta    ? 1 : 0;
  const informe = r.informe ? 1 : 0;

  // Guía de Instalación cuenta si tiene valor (incluyendo "No Aplica")
  const instOk = r.guiaInstN && r.guiaInstN.trim() ? 1 : 0;
  const desOk  = r.guiaDesN  && r.guiaDesN.trim()  ? 1 : 0;
  const guiaPart = (instOk + desOk) / 2; // 0, 0.5 o 1

  return Math.round((acta + guiaPart + informe) / 3 * 100);
}

// Indica si un campo de guía está bloqueado (auto-rellenado)
function isGuiaBlocked(r, tipo) {
  const key  = rowKey(r);
  const ov   = (state.overrides[key] || {});
  const rule = TRABAJO_GUIA_RULES[r.trabajoRealizar];
  if (!rule) return false;
  return tipo === 'inst' ? !!rule.blockInst : !!rule.blockDes;
}

let state = loadState();
let weekOffset = 0;

// ── Datos en vivo desde Google Sheets ──
// null = usar data.js (offline); objeto = usar datos del Sheet
let LIVE_DATA = null;
let sheetsLastSync = null;
let sheetsSyncError = false;

// currentData() usa Sheet si está disponible, si no, data.js
function currentData(){
  const src = LIVE_DATA || RAW_DATA;
  return src[state.currentBase] || [];
}

function loadState(){
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch(e){}

  const base = {
    currentUser: null,
    currentBase: 'PP.EE',
    currentMes: '',
    filters: { dpto:'', estado:'', tecnico:'', fecha:'', q:'' },
    overrides: {},
    tecnicos: [],
    usuarios: loadUsers(), // ← SIEMPRE de USERS_KEY, nunca del estado general
    notif: []
  };

  if(saved){
    // Aplicar estado guardado pero NUNCA sobreescribir usuarios con el estado viejo
    const { usuarios: _ignorado, ...savedSinUsuarios } = saved;
    Object.assign(base, savedSinUsuarios);
    base.usuarios = loadUsers(); // Re-aplicar usuarios desde su clave propia
  }

  // Verificar que currentUser todavía existe en la lista
  if(base.currentUser){
    const existe = base.usuarios.some(u => u.correo === base.currentUser.correo);
    if(!existe) base.currentUser = null;
  }

  return base;
}

function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  // Siempre mantener copia de seguridad de usuarios en su clave propia
  saveUsers();
}

// ---------------- LOGIN ----------------
function doLogin(){
  // Recargar usuarios frescos desde USERS_KEY antes de validar
  // (evita problemas si state se cargó antes de que USERS_KEY tuviera datos)
  state.usuarios = loadUsers();

  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const pass  = document.getElementById('loginPass').value.trim();

  const user = state.usuarios.find(u =>
    u.correo.trim().toLowerCase() === email && u.pass.trim() === pass
  );

  if(!user){
    const emailExists = state.usuarios.some(u => u.correo.trim().toLowerCase() === email);
    if(emailExists){
      alert('❌ Contraseña incorrecta.\nVerifica que no tenga espacios extras.');
    } else {
      alert(`❌ Correo "${email}" no encontrado.\n\nCorreos registrados:\n• ` +
        state.usuarios.map(u => u.correo).join('\n• ') +
        '\n\nSi acabas de crear el usuario, verifica que se guardó correctamente en la pestaña Usuarios.');
    }
    return;
  }

  state.currentUser = user;
  saveState();
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('userTag').textContent = `${user.nombre} · ${user.rol}`;
  init();
}

function logout(){ state.currentUser = null; saveState(); location.reload(); }

// ---------------- KEY / ROW helpers ----------------
function rowKey(r){ return `${r.tipoBase}|${r.oit}`; }

// Normaliza cualquier formato de fecha a yyyy-MM-dd (requerido por input[type=date])
// Maneja: "19/06/2026" (DD/MM/YYYY), "2026-06-19" (ya correcto),
//         "06/19/2026" (MM/DD/YYYY), Date objects, null/undefined
function normDate(v){
  if(!v) return '';
  const s = String(v).trim();
  if(!s || s === 'null' || s === 'undefined') return '';

  // Ya está en formato correcto yyyy-MM-dd
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Formato DD/MM/YYYY (peruano) — el más común en el Sheet
  const dmY = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(dmY){
    const [,d,m,y] = dmY;
    // Detectar si es DD/MM o MM/DD según el valor del primer número
    // Si el primer número > 12, definitivamente es DD/MM
    if(parseInt(d) > 12){
      return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
    // Asumimos DD/MM/YYYY (formato peruano)
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // Formato con guiones DD-MM-YYYY
  const dmYg = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if(dmYg){
    const [,d,m,y] = dmYg;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // Intentar parsear como Date de JavaScript
  const d = new Date(s);
  if(!isNaN(d.getTime())){
    return d.toISOString().slice(0,10);
  }

  return '';
}

// Únicos campos que el usuario puede sobreescribir desde el dashboard.
// TODOS los demás campos (sfa, cliente, direccion, etc.) siempre
// vienen del Sheet/data.js — los overrides NO los afectan.
const OPERATIONAL_OVERRIDABLE = new Set([
  'estado','tecnico','fechaMigr','fechaAsignada','supervEntel',
  'tipoTrabajo','trabajoRealizar','tipoOit',
  'acta','guia','informe',
  'guiaInstN','guiaInstS','guiaDesN','guiaDesS',
  'bw','cambioCpe','horario',
]);

function getRow(raw){
  const ov = state.overrides[rowKey(raw)] || {};
  const merged = Object.assign({}, raw);

  // Normalizar fechas del raw data
  if(merged.fechaMigr)    merged.fechaMigr    = normDate(merged.fechaMigr);
  if(merged.fechaAsignada) merged.fechaAsignada = normDate(merged.fechaAsignada);

  Object.entries(ov).forEach(([k, v]) => {
    if(k === 'custom' || k === 'comentarios' || k.startsWith('_')){
      merged[k] = v; return;
    }
    if(OPERATIONAL_OVERRIDABLE.has(k)){
      // Normalizar fechas del override también
      if((k === 'fechaMigr' || k === 'fechaAsignada') && v){
        merged[k] = normDate(v);
      } else {
        merged[k] = v;
      }
    }
  });

  merged.custom      = Object.assign({}, raw.custom||{}, ov.custom||{});
  merged.comentarios = ov.comentarios || [];
  return merged;
}

// ---------------- INIT ----------------
function init(){
  populateDeptoFilter();
  populateMesSelect();
  populateTecnicoFilter();
  renderTabla();
  renderAlertas();
  renderTecnicos();
  renderUsuarios();
  renderNotif();
  renderWeek();
}

function currentData(){ return (LIVE_DATA || RAW_DATA)[state.currentBase] || []; }

function setBase(base){
  state.currentBase = base;
  state.currentMes = '';
  document.getElementById('btnPP').classList.toggle('active', base==='PP.EE');
  document.getElementById('btnRR').classList.toggle('active', base==='RR.EE');
  saveState();
  populateDeptoFilter();
  populateMesSelect();
  populateTecnicoFilter();
  applyFilters();
  renderAlertas();
  renderTecnicos();
  renderWeek();
}

function populateMesSelect(){
  const sel = document.getElementById('mesSelect');
  const meses = [...new Set(currentData().map(r=>r.mes).filter(Boolean))];
  const order = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SETIEMBRE','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
  meses.sort((a,b)=> order.indexOf(a)-order.indexOf(b));
  sel.innerHTML = '<option value="">Todos los meses</option>' + meses.map(m=>`<option value="${m}">${m}</option>`).join('');
  sel.value = state.currentMes || '';
}
function populateDeptoFilter(){
  const dptos = [...new Set(currentData().map(r=>r.dpto).filter(Boolean))].sort();
  document.getElementById('fDpto').innerHTML = '<option value="">Todos los departamentos</option>' + dptos.map(d=>`<option value="${d}">${d}</option>`).join('');
  document.getElementById('tecDpto').innerHTML = '<option>General</option>' + dptos.map(d=>`<option>${d}</option>`).join('');
}
function populateTecnicoFilter(){
  const tecs = new Set();
  currentData().forEach(r=>{ const row=getRow(r); if(row.tecnico) tecs.add(row.tecnico); });
  state.tecnicos.forEach(t=>tecs.add(t.nombre));
  const opts = [...tecs].sort().map(t=>`<option value="${t}">${t}</option>`).join('');
  document.getElementById('fTecnico').innerHTML = '<option value="">Todos los técnicos</option>' + opts;
  document.getElementById('tecOptions').innerHTML = [...tecs].sort().map(t=>`<option value="${t}">`).join('');
}

// ---------------- FILTROS ----------------
function applyFilters(){
  state.currentMes = document.getElementById('mesSelect').value;
  state.filters.dpto = document.getElementById('fDpto').value;
  state.filters.estado = document.getElementById('fEstado').value;
  state.filters.tecnico = document.getElementById('fTecnico').value;
  state.filters.fecha = document.getElementById('fFecha').value;
  state.filters.q = document.getElementById('fBuscar').value.toLowerCase();
  saveState();
  renderTabla();
}
function clearFilters(){
  ['mesSelect','fDpto','fEstado','fTecnico','fFecha'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('fBuscar').value='';
  applyFilters();
}
function scrollTable(dir){ document.getElementById('tableWrap').scrollLeft += dir*300; }

function daysDiff(dateStr){
  if(!dateStr) return null;
  const d = new Date(dateStr+'T00:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((d-today)/86400000);
}

function filteredRows(){
  return currentData().map(getRow).filter(r=>{
    if(state.currentMes && r.mes !== state.currentMes) return false;
    if(state.filters.dpto && r.dpto !== state.filters.dpto) return false;
    if(state.filters.estado && r.estado !== state.filters.estado) return false;
    if(state.filters.tecnico && r.tecnico !== state.filters.tecnico) return false;
    if(state.filters.fecha){
      const dd = daysDiff(r.fechaMigr);
      if(state.filters.fecha==='hoy' && dd!==0) return false;
      if(state.filters.fecha==='semana' && !(dd!==null && dd>=0 && dd<=7)) return false;
      if(state.filters.fecha==='mes' && !(dd!==null && dd>=0 && dd<=31)) return false;
      if(state.filters.fecha==='vencidos' && !(dd!==null && dd<0)) return false;
    }
    if(state.filters.q){
      const blob = `${r.oit} ${r.cliente} ${r.distrito} ${r.dpto} ${r.sfa}`.toLowerCase();
      if(!blob.includes(state.filters.q)) return false;
    }
    return true;
  });
}

// ---------------- TABLA ----------------
function renderTabla(){
  const rows = filteredRows();
  const all = currentData();
  document.getElementById('totalCount').textContent = all.length;
  document.getElementById('countLabel').textContent = `${rows.length} de ${all.length} registros`;

  document.getElementById('kpiTotal').textContent = rows.length;
  document.getElementById('kpiAgend').textContent = rows.filter(r=>r.estado==='AGENDADO').length;
  document.getElementById('kpiPaus').textContent  = rows.filter(r=>r.estado==='PAUSADO').length;
  document.getElementById('kpiFin').textContent   = rows.filter(r=>r.estado==='FINALIZADO').length;
  document.getElementById('kpiElim').textContent  = rows.filter(r=>r.estado==='ELIMINADO').length;
  document.getElementById('kpiCons').textContent  = rows.filter(r=>r.estado==='CONSULTA').length;

  const tbody = document.getElementById('tablaBody');
  if(rows.length===0){ tbody.innerHTML = `<tr><td colspan="23" class="empty">No hay registros con estos filtros.</td></tr>`; return; }

  tbody.innerHTML = rows.map(r=>{
    const key = rowKey(r);
    const pctParts = [r.acta, r.guia, r.informe].filter(Boolean).length;
    const pct = Math.round(pctParts/3*100);
    const estado = r.estado || 'AGENDADO';
    // Horario separado en inicio y fin para pickers
    const [horIni='', horFin=''] = (r.horario||'').split(' - ');
    return `<tr>
      <td>${r.mes||''}</td>
      <td><input class="td-input" style="width:108px;" value="${r.fechaAsignada||''}" type="date"
          onchange="quickUpdate('${key}','fechaAsignada',this.value)"></td>
      <td>${r.oit||''}</td>
      <td><select class="sel-inline" onchange="quickUpdate('${key}','supervEntel',this.value)">
        <option value="">— Supervisor —</option>
        <option value="Irwinng Inocente"  ${r.supervEntel==='Irwinng Inocente' ?'selected':''}>Irwinng Inocente</option>
        <option value="Gonzalo Estrella"  ${r.supervEntel==='Gonzalo Estrella' ?'selected':''}>Gonzalo Estrella</option>
        <option value="Diego Gutiérrez"   ${r.supervEntel==='Diego Gutiérrez'  ?'selected':''}>Diego Gutiérrez</option>
      </select></td>
      <td>${r.sfa||''}</td>
      <td class="td-cliente" title="${r.cliente||''}">${r.cliente||''}</td>
      <td><select class="sel-inline" onchange="quickUpdate('${key}','tipoOit',this.value)">
        <option value="">— Tipo —</option>
        <option value="ALTA" ${r.tipoOit==='ALTA'?'selected':''}>ALTA</option>
        <option value="BAJA" ${r.tipoOit==='BAJA'?'selected':''}>BAJA</option>
      </select></td>
      <td class="ellipsis" title="${r.direccion||''}">${r.direccion||''}</td>
      <td>${r.distrito||''}</td>
      <td>${r.dpto||''}</td>
      <td><select class="sel-inline" onchange="quickUpdate('${key}','tipoTrabajo',this.value)">
        <option value="">— Tipo —</option>
        <option value="Desmontaje"              ${r.tipoTrabajo==='Desmontaje'             ?'selected':''}>Desmontaje</option>
        <option value="Mantenimiento Preventivo" ${r.tipoTrabajo==='Mantenimiento Preventivo'?'selected':''}>Mantenimiento Preventivo</option>
      </select></td>
      <td><select class="sel-inline" onchange="quickUpdate('${key}','trabajoRealizar',this.value)">
        <option value="">— Trabajo —</option>
        <option value="Desinstalación de Equipos" ${r.trabajoRealizar==='Desinstalación de Equipos'?'selected':''}>Desinstalación de Equipos</option>
        <option value="UpGrade"                   ${r.trabajoRealizar==='UpGrade'                  ?'selected':''}>UpGrade</option>
        <option value="Reubicación"               ${r.trabajoRealizar==='Reubicación'              ?'selected':''}>Reubicación</option>
        <option value="Adición de Equipo"         ${r.trabajoRealizar==='Adición de Equipo'        ?'selected':''}>Adición de Equipo</option>
        <option value="Cambio de Equipo"          ${r.trabajoRealizar==='Cambio de Equipo'         ?'selected':''}>Cambio de Equipo</option>
      </select></td>
      <td><input class="td-input" style="width:120px;" value="${r.fechaMigr||''}" type="date"
          onchange="quickUpdate('${key}','fechaMigr',this.value)"></td>
      <td>
        <div style="display:flex;align-items:center;gap:4px;white-space:nowrap;">
          <input class="td-input" style="width:76px;" type="time" value="${horIni}"
            onchange="updateHorario('${key}','ini',this.value)">
          <span style="color:var(--muted);font-size:11px;">—</span>
          <input class="td-input" style="width:76px;" type="time" value="${horFin}"
            onchange="updateHorario('${key}','fin',this.value)">
        </div>
      </td>
      <td>${r.dias||'-'}</td>
      <td><select class="sel-inline" onchange="quickUpdate('${key}','tecnico',this.value)">
        <option value="">Sin asignar</option>
        ${[...new Set([...state.tecnicos.map(t=>t.nombre), r.tecnico].filter(Boolean))].map(t=>`<option value="${t}" ${t===r.tecnico?'selected':''}>${t}</option>`).join('')}
      </select></td>
      <td><select class="sel-inline estado-select badge ${estado}" onchange="quickUpdate('${key}','estado',this.value)">
        <option value="AGENDADO"   ${estado==='AGENDADO'  ?'selected':''}>AGENDADO</option>
        <option value="PAUSADO"    ${estado==='PAUSADO'   ?'selected':''}>PAUSADO</option>
        <option value="FINALIZADO" ${estado==='FINALIZADO'?'selected':''}>FINALIZADO</option>
        <option value="ELIMINADO"  ${estado==='ELIMINADO' ?'selected':''}>ELIMINADO</option>
        <option value="CONSULTA"   ${estado==='CONSULTA'  ?'selected':''}>CONSULTA</option>
      </select></td>
      <td class="entreg-cell">
        <div class="entreg-badges">
          <span class="echip ${r.acta?'done':''}" onclick="toggleEntregable('${key}','acta')">${r.acta?'✓ ':''}Acta</span>
          <span class="echip" style="cursor:default;opacity:.6;font-size:9.5px;" title="Calculado según guías llenadas">📎 Guía</span>
          <span class="echip ${r.informe?'done':''}" onclick="toggleEntregable('${key}','informe')">${r.informe?'✓ ':''}Informe</span>
          <span class="epct">${calcEntregPct(r)}%</span>
        </div>
        <div class="eprogress"><div style="width:${calcEntregPct(r)}%"></div></div>
        <div style="font-size:9px;color:var(--muted);margin-top:3px;">
          ${(r.guiaInstN&&r.guiaInstN.trim())?'<span style="color:var(--green);font-size:9px;">✓ G.Inst</span>':'<span style="color:var(--muted2);font-size:9px;">○ G.Inst</span>'}
          ${(r.guiaDesN&&r.guiaDesN.trim())?'<span style="color:var(--green);font-size:9px;margin-left:4px;">✓ G.Des</span>':'<span style="color:var(--muted2);font-size:9px;margin-left:4px;">○ G.Des</span>'}
        </div>
      </td>
      <td class="guide-n">${isGuiaBlocked(r,'inst')
        ? `<input value="No Aplica" disabled style="opacity:.45;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08);cursor:not-allowed;width:100%;padding:5px 8px;font-size:12px;border-radius:6px;">`
        : `<input value="${r.guiaInstN||''}" placeholder="T118-…" onchange="quickUpdate('${key}','guiaInstN',this.value)">`}
      </td>
      <td class="guide-s">${isGuiaBlocked(r,'inst')
        ? `<input value="No Aplica" disabled style="opacity:.45;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08);cursor:not-allowed;width:100%;padding:5px 8px;font-size:12px;border-radius:6px;">`
        : `<input value="${r.guiaInstS||''}" placeholder="893531-…" onchange="quickUpdate('${key}','guiaInstS',this.value)">`}
      </td>
      <td class="guide-n">${isGuiaBlocked(r,'des')
        ? `<input value="No Aplica" disabled style="opacity:.45;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08);cursor:not-allowed;width:100%;padding:5px 8px;font-size:12px;border-radius:6px;">`
        : `<input value="${r.guiaDesN||''}" placeholder="T118-…" onchange="quickUpdate('${key}','guiaDesN',this.value)">`}
      </td>
      <td class="guide-s">${isGuiaBlocked(r,'des')
        ? `<input value="No Aplica" disabled style="opacity:.45;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08);cursor:not-allowed;width:100%;padding:5px 8px;font-size:12px;border-radius:6px;">`
        : `<input value="${r.guiaDesS||''}" placeholder="345198-…" onchange="quickUpdate('${key}','guiaDesS',this.value)">`}
      </td>
      <td class="acciones-cell">
        <button class="icon-btn view" title="Ver detalle completo" onclick="openModal('${key}')">👁</button>
        <button class="icon-btn up" title="Ver ubicación en Google Maps" onclick="openLocation('${key}')">📍</button>
        <button class="icon-btn share" title="Notificar al técnico" onclick="openNotifModal('${key}')">🔔</button>
      </td>
    </tr>`;
  }).join('');
}

// Helper: combinar hora inicio y fin en string "HH:MM - HH:MM"
function updateHorario(key, parte, valor){
  state.overrides[key] = state.overrides[key] || {};
  const [tipoBase, oit] = key.split('|');
  const raw = RAW_DATA[tipoBase].find(r=>String(r.oit)===oit);
  const r = getRow(raw);
  const partes = (r.horario||' - ').split(' - ');
  if(parte==='ini') partes[0] = valor;
  else               partes[1] = valor;
  state.overrides[key].horario = partes.join(' - ');
  saveState();
}

function quickUpdate(key, field, value){
  state.overrides[key] = state.overrides[key] || {};
  const prev = state.overrides[key][field];
  state.overrides[key][field] = value;

  // ── Reglas de auto-bloqueo de guías ──
  if(field === 'trabajoRealizar'){
    applyGuiaRules(key, value);
    // Notificación si el trabajo cambió
    state.notif.unshift({ ts:new Date().toLocaleString('es-PE'), msg:`Trabajo a realizar de OIT ${key.split('|')[1]} cambiado a "${value}"` });
    saveState();
    renderTabla(); renderAlertas(); renderTecnicos(); renderNotif(); renderWeek(); populateTecnicoFilter();
    return;
  }

  if(field==='tecnico' && value && value !== prev){
    saveState();
    showAssignModal(key, value);
    return;
  }
  if(field==='estado'){
    state.notif.unshift({ ts:new Date().toLocaleString('es-PE'), msg:`Estado de OIT ${key.split('|')[1]} cambiado a ${value.replace('_',' ')}` });
  }
  saveState();
  // Sincronizar cambio con Google Sheets
  pushToSheet(key, { [field]: value });
  renderTabla(); renderAlertas(); renderTecnicos(); renderNotif(); renderWeek(); populateTecnicoFilter();
}
function toggleEntregable(key, field){
  state.overrides[key] = state.overrides[key] || {};
  state.overrides[key][field] = !state.overrides[key][field];
  saveState();
  renderTabla();
}
function shareRow(key){
  const [tipoBase, oit] = key.split('|');
  const text = `SPSA - OIT ${oit} (${tipoBase})`;
  if(navigator.share){ navigator.share({title:text, text}); }
  else { navigator.clipboard?.writeText(text); alert('Enlace copiado: '+text); }
}

// ---------------- MODAL DETALLE ----------------
let activeKey = null;
function openModal(key){
  activeKey = key;
  const [tipoBase, oit] = key.split('|');
  const raw = RAW_DATA[tipoBase].find(r=>String(r.oit)===oit);
  const r = getRow(raw);
  const isAdmin = state.currentUser?.rol === 'Administrador';

  document.getElementById('dOit').textContent = r.oit;
  document.getElementById('dRolBadge').textContent = isAdmin
    ? '🔵 Administrador — todos los campos editables'
    : '🟣 Supervisor — edición parcial';

  // Identificación
  document.getElementById('dMes').value        = r.mes || '';
  document.getElementById('dFechaAsig').value  = r.fechaAsignada || '';
  document.getElementById('dOitVal').value     = r.oit || '';
  document.getElementById('dSupervEntel').value = r.supervEntel || '';
  document.getElementById('dSfa').value        = r.sfa || '';
  document.getElementById('dTipoOit').value    = r.tipoOit || '';

  // Cliente y ubicación
  document.getElementById('dCliente').value    = r.cliente || '';
  document.getElementById('dDireccion').value  = r.direccion || '';
  document.getElementById('dDistrito').value   = r.distrito || '';
  document.getElementById('dDpto').value       = r.dpto || '';

  // Campos de solo lectura para no-admin
  ['dCliente','dDireccion','dDistrito','dDpto','dSfa','dMes'].forEach(id=>{
    const el = document.getElementById(id);
    el.readOnly = !isAdmin;
    el.style.opacity = isAdmin ? '1' : '.55';
  });

  // Tipo de trabajo
  document.getElementById('dTipoTrabajo').value     = r.tipoTrabajo || '';
  document.getElementById('dTrabajoRealizar').value  = r.trabajoRealizar || '';

  // Programación
  const [horIni='', horFin=''] = (r.horario||'').split(' - ');
  document.getElementById('dFecha').value   = r.fechaMigr || '';
  document.getElementById('dHorIni').value  = horIni;
  document.getElementById('dHorFin').value  = horFin;
  document.getElementById('dDias').value    = r.dias || '';
  document.getElementById('dTecnico').value = r.tecnico || '';
  document.getElementById('dEstado').value  = r.estado || 'AGENDADO';

  // Entregables
  document.getElementById('dActa').checked    = !!r.acta;
  document.getElementById('dGuia').checked    = !!r.guia;
  document.getElementById('dInforme').checked = !!r.informe;

  // Guías — aplicar bloqueo según trabajo a realizar
  const rule = TRABAJO_GUIA_RULES[r.trabajoRealizar];
  const instBlocked = rule?.blockInst || false;
  const desBlocked  = rule?.blockDes  || false;

  const guiaFields = [
    { id:'dGuiaInstN', val: r.guiaInstN||'', blocked: instBlocked, auto: instBlocked ? 'No Aplica' : '' },
    { id:'dGuiaInstS', val: r.guiaInstS||'', blocked: instBlocked, auto: instBlocked ? 'No Aplica' : '' },
    { id:'dGuiaDesN',  val: r.guiaDesN||'',  blocked: desBlocked,  auto: desBlocked  ? 'No Aplica' : '' },
    { id:'dGuiaDesS',  val: r.guiaDesS||'',  blocked: desBlocked,  auto: desBlocked  ? 'No Aplica' : '' },
  ];
  guiaFields.forEach(gf => {
    const el = document.getElementById(gf.id);
    if(!el) return;
    el.value    = gf.blocked ? 'No Aplica' : gf.val;
    el.readOnly = gf.blocked;
    el.disabled = gf.blocked;
    el.style.opacity    = gf.blocked ? '.45' : '1';
    el.style.cursor     = gf.blocked ? 'not-allowed' : '';
    el.style.background = gf.blocked ? 'rgba(255,255,255,.03)' : '';
    el.style.borderColor= gf.blocked ? 'rgba(255,255,255,.08)' : '';
    el.title            = gf.blocked ? `No aplica para "${r.trabajoRealizar}"` : '';
  });

  // Mostrar aviso de bloqueo si aplica
  let guiaNote = '';
  if(instBlocked && desBlocked) guiaNote = `⚠️ Para <b>${r.trabajoRealizar}</b> no aplican Guía de Instalación ni Guía de Desinstalación.`;
  else if(instBlocked)           guiaNote = `⚠️ Para <b>${r.trabajoRealizar}</b> no aplica Guía de Instalación.`;
  else if(desBlocked)            guiaNote = `⚠️ Para <b>${r.trabajoRealizar}</b> no aplica Guía de Desinstalación.`;
  const noteEl = document.getElementById('guiaBlockNote');
  if(noteEl){ noteEl.innerHTML = guiaNote; noteEl.style.display = guiaNote ? 'flex' : 'none'; }

  // Comentarios
  document.getElementById('dComentarioNuevo').value = '';
  const hist = r.comentarios || [];
  document.getElementById('dComentarioHist').innerHTML = hist.length
    ? hist.map(c=>`<div style="padding:6px 0;border-bottom:1px solid var(--border);">
        <span style="color:var(--muted);font-size:10.5px;">🕐 ${c.ts}</span><br>${c.text}
      </div>`).join('')
    : '<div style="color:var(--muted);font-style:italic;font-size:12px;">Sin comentarios todavía.</div>';

  // Datalist técnicos
  document.getElementById('tecOptions').innerHTML =
    [...new Set([...state.tecnicos.map(t=>t.nombre), r.tecnico].filter(Boolean))].map(t=>`<option value="${t}">`).join('');

  // Campos custom
  const cfc = document.getElementById('customFieldsContainer');
  cfc.innerHTML = CUSTOM_FIELDS.map(f=>`
    <div class="field"><label>${f.label}</label>
      <input id="custom_${f.key}" type="${f.type==='number'?'number':(f.type==='date'?'date':'text')}" value="${r.custom?.[f.key]??''}">
    </div>`).join('');

  document.getElementById('detailModal').classList.add('active');
}
function closeModal(){ document.getElementById('detailModal').classList.remove('active'); activeKey=null; }

function saveDetail(){
  if(!activeKey) return;
  const prev = state.overrides[activeKey] || {};
  const prevTec = prev.tecnico;
  const newTec = document.getElementById('dTecnico').value;
  const horIni = document.getElementById('dHorIni').value;
  const horFin = document.getElementById('dHorFin').value;
  const nuevoTrabajo = document.getElementById('dTrabajoRealizar').value;
  const custom = {};
  CUSTOM_FIELDS.forEach(f=>{ const el=document.getElementById('custom_'+f.key); if(el) custom[f.key]=el.value; });
  const comentarios = prev.comentarios || [];
  const nuevo = document.getElementById('dComentarioNuevo').value.trim();
  if(nuevo) comentarios.unshift({ ts:new Date().toLocaleString('es-PE'), text:nuevo });

  // Determinar reglas de guía según trabajo a realizar
  const rule = TRABAJO_GUIA_RULES[nuevoTrabajo];
  const instBlocked = rule?.blockInst || false;
  const desBlocked  = rule?.blockDes  || false;

  state.overrides[activeKey] = {
    fechaAsignada   : document.getElementById('dFechaAsig').value,
    supervEntel     : document.getElementById('dSupervEntel').value,
    sfa             : document.getElementById('dSfa').value,
    tipoOit         : document.getElementById('dTipoOit').value,
    cliente         : document.getElementById('dCliente').value,
    direccion       : document.getElementById('dDireccion').value,
    distrito        : document.getElementById('dDistrito').value,
    dpto            : document.getElementById('dDpto').value,
    tipoTrabajo     : document.getElementById('dTipoTrabajo').value,
    trabajoRealizar : nuevoTrabajo,
    fechaMigr       : document.getElementById('dFecha').value,
    horario         : horIni||horFin ? `${horIni} - ${horFin}` : (prev.horario||''),
    dias            : document.getElementById('dDias').value,
    tecnico         : newTec,
    estado          : document.getElementById('dEstado').value,
    acta            : document.getElementById('dActa').checked,
    guia            : document.getElementById('dGuia').checked,
    informe         : document.getElementById('dInforme').checked,
    // Guías: si bloqueado, guardar "No Aplica"; si no, el valor del input
    guiaInstN       : instBlocked ? 'No Aplica' : document.getElementById('dGuiaInstN').value,
    guiaInstS       : instBlocked ? 'No Aplica' : document.getElementById('dGuiaInstS').value,
    guiaDesN        : desBlocked  ? 'No Aplica' : document.getElementById('dGuiaDesN').value,
    guiaDesS        : desBlocked  ? 'No Aplica' : document.getElementById('dGuiaDesS').value,
    // Flags internos para saber si fueron auto-rellenados
    _guiaInstAuto   : instBlocked,
    _guiaDesAuto    : desBlocked,
    comentarios, custom
  };
  if(newTec && newTec !== prevTec){
    state.notif.unshift({ ts:new Date().toLocaleString('es-PE'), msg:`Técnico "${newTec}" asignado a OIT ${activeKey.split('|')[1]}` });
  }
  saveState();
  // Sincronizar con Google Sheets (todos los campos del modal)
  const sheetChanges = state.overrides[activeKey] || {};
  pushToSheet(activeKey, sheetChanges);
  closeModal();
  renderTabla(); renderAlertas(); renderTecnicos(); renderNotif(); renderWeek(); populateTecnicoFilter();
}

// ---------------- EXPORT CSV ----------------
function exportCSV(){
  const rows = filteredRows();
  const headers = ['Mes','OIT','SFA','Cliente','Tipo OIT','Dirección','Distrito','Dpto.','Fecha Migr.','Horario','Días','Técnico','Estado','Acta','Guía','Informe','N°GuíaInst','SerieInst','N°GuíaDesinst','SerieDesinst'];
  const lines=[headers.join(',')];
  rows.forEach(r=>{
    const vals=[r.mes,r.oit,r.sfa,r.cliente,r.tipoOit,r.direccion,r.distrito,r.dpto,r.fechaMigr,r.horario,r.dias,r.tecnico,r.estado,
      r.acta?'Sí':'No', r.guia?'Sí':'No', r.informe?'Sí':'No', r.guiaInstN, r.guiaInstS, r.guiaDesN, r.guiaDesS]
      .map(v=>`"${(v??'').toString().replace(/"/g,'""')}"`);
    lines.push(vals.join(','));
  });
  const blob = new Blob([lines.join('\n')], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=`SPSA_${state.currentBase}_${state.currentMes||'todos'}.csv`; a.click();
}

// ---------------- TABS ----------------
function showView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  document.querySelector(`.tab[data-view="${name}"]`).classList.add('active');
  if(name==='sector'){ setTimeout(()=>{ renderDptoDash(); renderMap(); }, 50); }
}

// ---------------- ALERTAS ----------------
function renderAlertas(){
  const rows = currentData().map(getRow);
  const venc = rows.filter(r=>daysDiff(r.fechaMigr)!==null && daysDiff(r.fechaMigr)<0 && r.estado!=='COMPLETADO')
    .sort((a,b)=>daysDiff(b.fechaMigr)-daysDiff(a.fechaMigr));
  const prox = rows.filter(r=>{ const d=daysDiff(r.fechaMigr); return d!==null && d>=0 && d<=7 && r.estado!=='COMPLETADO'; })
    .sort((a,b)=>daysDiff(a.fechaMigr)-daysDiff(b.fechaMigr));

  document.getElementById('vencCount').textContent = venc.length;
  document.getElementById('proxCount').textContent = prox.length;
  document.getElementById('vencList').innerHTML = venc.length ? venc.map(r=>`
    <div class="alert-card">
      <div><div class="title">OIT ${r.oit} – ${r.distrito}</div><div class="meta">${r.fechaMigr} · ${r.horario||'-'} · 👤 ${r.tecnico||'Sin asignar'}</div></div>
      <span class="alert-pill">Hace ${Math.abs(daysDiff(r.fechaMigr))}d</span>
    </div>`).join('') : '<div class="empty">Sin trabajos vencidos.</div>';
  document.getElementById('proxList').innerHTML = prox.length ? prox.map(r=>`
    <div class="alert-card">
      <div><div class="title">OIT ${r.oit} – ${r.distrito}</div><div class="meta">${r.fechaMigr} · ${r.horario||'-'} · 👤 ${r.tecnico||'Sin asignar'}</div></div>
      <span class="alert-pill">${daysDiff(r.fechaMigr)}d</span>
    </div>`).join('') : '<div class="empty">Sin trabajos próximos.</div>';
}

// ---------------- TARJETAS DEPARTAMENTO ----------------
function renderDptoDash(){
  const allRows = currentData().map(getRow);
  const dptos = [...new Set(allRows.map(r=>r.dpto).filter(Boolean))].sort();
  const grid = document.getElementById('dptoDashGrid');
  if(!grid) return;
  grid.innerHTML = dptos.map((d,i)=>{
    const color = DPTO_COLORS[i % DPTO_COLORS.length];
    const items = allRows.filter(r=>r.dpto===d);
    const total = items.length;
    const comp = items.filter(r=>r.estado==='COMPLETADO').length;
    const proc = items.filter(r=>r.estado==='EN_PROCESO').length;
    const pend = items.filter(r=>r.estado==='PENDIENTE'||r.estado==='VENCIDO').length;
    const sinTec = items.filter(r=>!r.tecnico).length;
    const pct = total ? Math.round(comp/total*100) : 0;
    const pctColor = pct===0 ? 'var(--orange)' : pct<50 ? 'var(--blue)' : 'var(--green)';
    return `<div class="dpto-card">
      <div class="dh"><span class="dot-dpto" style="background:${color}"></span>${d}</div>
      <div class="sedes-n" style="color:${color}">${total} <span style="font-size:14px;font-weight:400;color:var(--muted)">sedes</span></div>
      <div class="sep" style="background:${color}"></div>
      <div class="stat-row">
        <span>✅ ${comp} completos</span>
        <span>🔵 ${proc} en proceso</span>
        <span>⏳ ${pend} pendientes</span>
      </div>
      <div class="stat-row"><span>👤 ${sinTec} sin técnico</span></div>
      <div class="pct-line" style="color:${pctColor}">${pct}% completado</div>
    </div>`;
  }).join('');
}

// ---------------- SECTORIZACION ----------------
let leafletMap = null;
const DPTO_COLORS = ['#ef4444','#06b6d4','#a855f7','#f59e0b','#22c55e','#3b82f6','#eab308','#ec4899','#84cc16','#f97316'];
function dptoColor(dpto, list){ return DPTO_COLORS[list.indexOf(dpto) % DPTO_COLORS.length]; }
function renderMap(){
  const rows = filteredRows().filter(r=>r.lat && r.lon);
  const dptos = [...new Set(filteredRows().map(r=>r.dpto).filter(Boolean))].sort();
  document.getElementById('mapLegend').innerHTML = dptos.map(d=>`<span><span class="dot" style="background:${dptoColor(d,dptos)}"></span>${d}</span>`).join('');
  if(!leafletMap){
    leafletMap = L.map('map').setView([-9.19,-75.0], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution:'© OpenStreetMap'}).addTo(leafletMap);
    window._markersLayer = L.layerGroup().addTo(leafletMap);
  }
  window._markersLayer.clearLayers();
  if(!rows.length) return;
  const bounds=[];
  rows.forEach(r=>{
    const color = dptoColor(r.dpto, dptos);
    const m = L.circleMarker([r.lat,r.lon], {radius:7, color, fillColor:color, fillOpacity:.85, weight:1});
    m.bindPopup(`<b>OIT ${r.oit}</b><br>${r.cliente||''}<br>${r.distrito}, ${r.dpto}<br>Estado: ${r.estado}`);
    m.addTo(window._markersLayer);
    bounds.push([r.lat,r.lon]);
  });
  leafletMap.fitBounds(bounds, {padding:[30,30]});
}
function exportKML(){
  const rows = filteredRows().filter(r=>r.lat && r.lon);
  if(!rows.length){ alert('No hay registros con coordenadas para exportar.'); return; }
  let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n`;
  rows.forEach(r=>{ kml += `<Placemark><name>OIT ${r.oit}</name><description>${(r.cliente||'').replace(/&/g,'&amp;')} - ${r.distrito}, ${r.dpto}</description><Point><coordinates>${r.lon},${r.lat},0</coordinates></Point></Placemark>\n`; });
  kml += `</Document></kml>`;
  const blob = new Blob([kml], {type:'application/vnd.google-earth.kml+xml'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=`SPSA_${state.currentBase}_Sectorizacion.kml`; a.click();
}

// ---------------- UBICACIÓN ----------------
function openLocation(key){
  const [tipoBase, oit] = key.split('|');
  const raw = RAW_DATA[tipoBase].find(r=>String(r.oit)===oit);
  const r = getRow(raw);
  if(r.lat && r.lon){
    window.open(`https://www.google.com/maps?q=${r.lat},${r.lon}&z=17`, '_blank');
  } else if(r.direccion){
    window.open(`https://www.google.com/maps/search/${encodeURIComponent(r.direccion)}`, '_blank');
  } else {
    alert('Esta OIT no tiene coordenadas ni dirección disponible.');
  }
}

// ---------------- MODAL ASIGNACIÓN (popup cuando se asigna técnico) ----------------
function showAssignModal(key, tecnico){
  const [tipoBase, oit] = key.split('|');
  const raw = RAW_DATA[tipoBase].find(r=>String(r.oit)===oit);
  const r = getRow(raw);
  const tec = state.tecnicos.find(t=>t.nombre===tecnico);

  document.getElementById('assignOit').textContent = oit;
  document.getElementById('assignTec').textContent = tecnico;

  const list = document.getElementById('assignStatusList');
  list.innerHTML = `
    <div class="assign-item" id="as-email">📧 <b>Correo al técnico</b> (${tec?.correo||'sin correo'}) <span class="assign-tag pending">Enviando…</span></div>
    <div class="assign-item" id="as-wa">📱 <b>WhatsApp al técnico</b> (${tec?.cel||'sin número'}) <span class="assign-tag pending">Enviando…</span></div>
    <div class="assign-item" id="as-log">📑 <b>Solicitud de Equipo a logística</b> <span class="assign-tag pending">Enviando…</span></div>`;

  document.getElementById('assignModal').classList.add('active');

  const cfg = getConfig();
  const params = buildEmailParams(r, tecnico, tec);

  // Notif log
  state.notif.unshift({ ts:new Date().toLocaleString('es-PE'), msg:`Técnico "${tecnico}" asignado a OIT ${oit} (${tipoBase})` });
  saveState();
  renderTabla(); renderAlertas(); renderTecnicos(); renderNotif(); renderWeek(); populateTecnicoFilter();

  // ── EMAIL AL TÉCNICO ──
  if(tec?.correo && cfg.emailJsKey && cfg.templateId){
    sendEmail(cfg.templateId, params, tec.correo)
      .then(()=>{ setAssignStatus('as-email','✅ Enviado a '+tec.correo,'ok'); })
      .catch(e=>{ setAssignStatus('as-email','❌ Error: '+(e.text||JSON.stringify(e)),'err'); });
  } else {
    setAssignStatus('as-email', tec?.correo ? '⚠️ EmailJS no configurado' : '⚠️ Técnico sin correo registrado', 'warn');
  }

  // ── WHATSAPP AL TÉCNICO ──
  // Construye el mensaje de asignación
  const waMsg = `🔔 *Nueva Asignación de Trabajo*\n` +
    `Gestión de Trabajos – Entel\n\n` +
    `Estimado/a *${tecnico}*,\nSe te ha asignado el siguiente trabajo:\n\n` +
    `📋 *OIT:* ${oit}\n` +
    `📦 *SFA:* ${r.sfa||'-'}\n` +
    `🏢 *Cliente:* ${r.cliente||'-'}\n` +
    `📍 *Dirección:* ${r.direccion||'-'}\n` +
    `🏙 *Distrito:* ${r.distrito||'-'}, ${r.dpto||'-'}\n` +
    `📅 *Fecha:* ${r.fechaMigr||'Por coordinar'}\n` +
    `🕐 *Horario:* ${r.horario||'-'}\n\n` +
    `_Sistema Gestión de Trabajos – Entel_`;

  if(tec?.cel && tec?.waKey){
    // Tiene API Key → envío automático por CallMeBot
    sendWhatsApp(tec.cel, tec.waKey, waMsg)
      .then(()=>{ setAssignStatus('as-wa','✅ WhatsApp enviado automáticamente a '+tec.cel,'ok'); })
      .catch(e=>{ setAssignStatus('as-wa','❌ Error CallMeBot: '+e,'err'); });
  } else if(tec?.cel){
    // Sin API Key → abrir WhatsApp Web con el mensaje listo
    const phone = tec.cel.replace(/[\s+\-()]/g,'');
    const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(waMsg)}`;
    setAssignStatus('as-wa',
      `⚠️ Sin API Key — <a href="${waUrl}" target="_blank" style="color:var(--green);font-weight:700;">📲 Abrir WhatsApp Web para enviar manualmente</a>`,
      'warn');
  } else {
    setAssignStatus('as-wa','⚠️ Técnico sin número registrado — agrégalo en Carga de Técnicos','warn');
  }

  // ── SOLICITUD DE EQUIPO A LOGÍSTICA (Apps Script + Excel adjunto) ──
  const appsScriptUrl = cfg.appsScriptUrl || '';
  if(appsScriptUrl){
    const logPayload = {
      oit        : String(r.oit||''),
      sfa        : r.sfa||'-',
      cliente    : r.cliente||'-',
      tipo       : r.tipoOit||r.sfa||'-',
      direccion  : r.direccion||'-',
      distrito   : r.distrito||'-',
      dpto       : r.dpto||'-',
      fecha      : r.fechaMigr||'Por coordinar',
      horario    : r.horario||'-',
      tecnico    : tecnico,
      correoTecnico: tec?.correo||'',
      bw         : r.custom?.bw||'-',
      cambioCpe  : r.custom?.cambioCpe||'-',
      destinatarios: [
        'logistica@felosotec.com',
        'aarana@felosotec.com',
        'mcamasca@felosotec.com',
        'mvillacorta@felosotec.com',
        'ezevallos@felosotec.com',
        'lruiz@felosotec.com',
        'djimenez@felosotec.com'
      ]
    };
    fetch(appsScriptUrl, {
      method:'POST',
      headers:{'Content-Type':'text/plain'},
      body: JSON.stringify(logPayload),
      mode:'no-cors'
    })
    .then(()=>{ setAssignStatus('as-log','✅ Solicitud de Equipo enviada a logística (7 destinatarios)','ok'); })
    .catch(e=>{ setAssignStatus('as-log','❌ Error Apps Script: '+e,'err'); });
  } else {
    setAssignStatus('as-log',
      '⚠️ Apps Script no configurado — <a href="#" onclick="closeAssignModal();openConfigModal();return false;" style="color:var(--orange);">Configura la URL aquí</a>',
      'warn');
  }
}

function setAssignStatus(id, msg, type){
  const el = document.getElementById(id);
  if(!el) return;
  const tag = el.querySelector('.assign-tag');
  if(tag){
    tag.innerHTML = msg;  // innerHTML para que los links <a> se rendericen correctamente
    tag.className = 'assign-tag ' + type;
  }
}
function closeAssignModal(){ document.getElementById('assignModal').classList.remove('active'); }

// ---------------- MODAL NOTIFICACIÓN MANUAL ----------------
let activeNotifKey = null;
function openNotifModal(key){
  activeNotifKey = key;
  const [tipoBase, oit] = key.split('|');
  const raw = RAW_DATA[tipoBase].find(r=>String(r.oit)===oit);
  const r = getRow(raw);
  const tec = state.tecnicos.find(t=>t.nombre===r.tecnico);
  document.getElementById('notifModalInfo').innerHTML = `
    <b>OIT ${oit}</b> · ${r.cliente||''}<br>
    📍 ${r.distrito}, ${r.dpto}<br>
    📅 ${r.fechaMigr||'Sin fecha'} · ${r.horario||'-'}<br>
    👤 Técnico: <b>${r.tecnico||'Sin asignar'}</b> · 📱 ${tec?.cel||'-'} · ✉ ${tec?.correo||'-'}`;
  document.getElementById('notifSendStatus').textContent = '';
  document.getElementById('notifMsgExtra').value = '';
  document.getElementById('notifModal').classList.add('active');
}
function closeNotifModal(){ document.getElementById('notifModal').classList.remove('active'); activeNotifKey=null; }

function doSendNotif(){
  if(!activeNotifKey) return;
  const [tipoBase, oit] = activeNotifKey.split('|');
  const raw = RAW_DATA[tipoBase].find(r=>String(r.oit)===oit);
  const r = getRow(raw);
  const tec = state.tecnicos.find(t=>t.nombre===r.tecnico);
  const cfg = getConfig();
  const extra = document.getElementById('notifMsgExtra').value.trim();
  const statusEl = document.getElementById('notifSendStatus');
  statusEl.textContent = '📤 Enviando...';
  const params = buildEmailParams(r, r.tecnico, tec, extra);

  let promises = [];

  if(tec?.correo && cfg.emailJsKey && cfg.templateId){
    promises.push(sendEmail(cfg.templateId, params, tec.correo)
      .then(()=>'✅ Correo enviado a '+tec.correo)
      .catch(e=>'❌ Error correo: '+(e.text||e)));
  } else { promises.push(Promise.resolve('⚠️ Sin correo o EmailJS no configurado')); }

  if(tec?.cel && tec?.waKey){
    const msg = `🔔 *Recordatorio – Gestión de Trabajos Entel*\nHola ${r.tecnico}:\n• OIT: ${oit}\n• Cliente: ${r.cliente||'-'}\n• Fecha: ${r.fechaMigr||'-'}\n• Horario: ${r.horario||'-'}${extra?'\n\n📝 '+extra:''}`;
    promises.push(sendWhatsApp(tec.cel, tec.waKey, msg)
      .then(()=>'✅ WhatsApp enviado automáticamente a '+tec.cel)
      .catch(e=>'❌ Error WhatsApp: '+e));
  } else if(tec?.cel){
    const msg = `🔔 *Recordatorio – Gestión de Trabajos Entel*\nHola ${r.tecnico}:\n• OIT: ${oit}\n• Cliente: ${r.cliente||'-'}\n• Fecha: ${r.fechaMigr||'-'}\n• Horario: ${r.horario||'-'}${extra?'\n\n📝 '+extra:''}`;
    const phone = tec.cel.replace(/[\s+\-()]/g,'');
    const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
    promises.push(Promise.resolve(`⚠️ Sin API Key — <a href="${waUrl}" target="_blank" style="color:var(--green);font-weight:700;">📲 Abrir WhatsApp Web para enviar manualmente</a>`));
  } else {
    promises.push(Promise.resolve('⚠️ Técnico sin número registrado'));
  }

  Promise.all(promises).then(results=>{
    statusEl.innerHTML = results.map(r=>`<div>${r}</div>`).join('');
    state.notif.unshift({ ts:new Date().toLocaleString('es-PE'), msg:`Notificación manual enviada para OIT ${oit} — ${r.tecnico||'sin técnico'}` });
    saveState(); renderNotif();
  });
}

// ---------------- EMAILJS + WHATSAPP ----------------
function getConfig(){
  try { return JSON.parse(localStorage.getItem('spsa_notif_config')) || {}; } catch(e){ return {}; }
}
function saveConfig(){
  const cfg = {
    emailJsKey    : document.getElementById('cfgEmailJsKey').value.trim(),
    serviceId     : document.getElementById('cfgServiceId').value.trim(),
    templateId    : document.getElementById('cfgTemplateId').value.trim(),
    appsScriptUrl : document.getElementById('cfgAppsScriptUrl').value.trim(),
  };
  localStorage.setItem('spsa_notif_config', JSON.stringify(cfg));
  if(cfg.emailJsKey){ emailjs.init(cfg.emailJsKey); }
  updateConfigStatus(cfg);
  closeConfigModal();
  alert('✅ Configuración guardada correctamente.');
}
function openConfigModal(){
  const KNOWN = {
    emailJsKey   : '_w0TN7D8axIDoqGPV',
    serviceId    : 'service_xgd1236',
    templateId   : 'template_g2cbtxs',
    appsScriptUrl: 'https://script.google.com/macros/s/AKfycbz4lYU5ISigWTc9lzvidvmyp3cHRfuM8t8EvAnmLKGebrvaQJPGAiOXZ90pr581KY2bKg/exec',
  };
  const cfg = Object.assign({}, KNOWN, getConfig());
  const map = {
    emailJsKey:'cfgEmailJsKey', serviceId:'cfgServiceId',
    templateId:'cfgTemplateId', appsScriptUrl:'cfgAppsScriptUrl'
  };
  Object.entries(map).forEach(([k,id])=>{
    const el = document.getElementById(id);
    if(el) el.value = cfg[k] || '';
  });
  document.getElementById('configModal').classList.add('active');
}
function closeConfigModal(){ document.getElementById('configModal').classList.remove('active'); }
function updateConfigStatus(cfg){
  const dot = document.querySelector('#emailjsStatus .dot');
  const txt = document.getElementById('emailjsStatusTxt');
  if(!dot||!txt) return;
  if(cfg.emailJsKey && cfg.serviceId && cfg.templateId){
    dot.style.background='var(--green)'; txt.textContent='EmailJS configurado';
  } else {
    dot.style.background='var(--muted)'; txt.textContent='Sin configurar';
  }
}
async function testEmail(){
  const cfg = getConfig();
  if(!cfg.emailJsKey||!cfg.serviceId||!cfg.templateId){ alert('Primero completa las claves de EmailJS.'); return; }
  emailjs.init(cfg.emailJsKey);
  const params = { to_email: state.currentUser?.correo||cfg.log1, oit:'TEST-001', cliente:'Cliente de prueba',
    direccion:'Dirección de prueba', distrito:'Lima', dpto:'Lima', fecha:'2026-06-22', horario:'08:30-12:30',
    tecnico:'Técnico de prueba', estado:'PENDIENTE', mensaje:'Este es un correo de prueba del sistema.' };
  try {
    await emailjs.send(cfg.serviceId, cfg.templateId, params);
    alert('✅ Correo de prueba enviado exitosamente. Revisa tu bandeja.');
  } catch(e){ alert('❌ Error al enviar: '+JSON.stringify(e)); }
}

function buildEmailParams(r, tecnico, tec, extra){
  return {
    // Identidad del remitente
    name          : 'Asignación de Trabajo',
    email         : 'elvis.articipri@gmail.com',
    // Destinatario
    tecnico_email : tec?.correo || '',
    tecnico       : tecnico || 'Técnico',
    // Datos de la OIT
    oit           : String(r.oit || ''),
    sfa           : r.sfa || '-',
    cliente       : r.cliente || '-',
    tipo          : r.tipoOit || r.sfa || '-',
    // Ubicación y programación
    direccion     : r.direccion || '-',
    distrito      : `${r.distrito || '-'}, ${r.dpto || '-'}`,
    fecha         : r.fechaMigr ? fechaConEtiqueta(r.fechaMigr) : 'Por coordinar',
    horario       : r.horario || '-',
    // Campos técnicos
    bw            : r.custom?.bw || '-',
    cambio_cpe    : r.custom?.cambioCpe || '-',
    // Link maps
    maps_link     : (r.lat && r.lon)
                      ? `https://www.google.com/maps?q=${r.lat},${r.lon}`
                      : `https://maps.google.com/?q=${encodeURIComponent(r.direccion || '')}`,
    mensaje       : extra || '',
  };
}

// Devuelve la fecha con etiqueta HOY / MAÑANA si aplica
function fechaConEtiqueta(fechaStr){
  const dd = daysDiff(fechaStr);
  const label = dd === 0 ? ' (HOY)' : dd === 1 ? ' (MAÑANA)' : dd === -1 ? ' (AYER)' : '';
  return `${fechaStr}${label}`;
}

async function sendEmail(templateId, params, toEmail){
  const cfg = getConfig();
  if(!cfg.emailJsKey || !cfg.serviceId || !templateId || !toEmail){
    throw {text:'Configuración incompleta — revisa EmailJS en Notificaciones'};
  }
  emailjs.init(cfg.emailJsKey);
  return emailjs.send(cfg.serviceId, templateId, params);
}

async function sendWhatsApp(cel, apiKey, message){
  const phone = cel.replace(/[\s+\-()]/g, '');
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;
  return fetch(url, {mode:'no-cors'});
}

async function testEmail(){
  const cfg = getConfig();
  if(!cfg.emailJsKey || !cfg.serviceId || !cfg.templateId){
    alert('Primero completa y guarda las claves de EmailJS.');
    return;
  }
  emailjs.init(cfg.emailJsKey);
  const params = {
    name          : 'Asignación de Trabajo',
    email         : 'elvis.articipri@gmail.com',
    tecnico_email : 'elvis.articipri@gmail.com',
    tecnico       : 'Elvis Artica Cipriano',
    oit           : 'S480796',
    sfa           : '551870',
    cliente       : 'COMPAÑIA HARD DISCOUNT S.A.C.',
    tipo          : 'MODIF',
    direccion     : 'Av. El Paraíso 192 Mz. U Lt. 2 A.H. El Paraíso',
    distrito      : 'Villa Maria del Triunfo, Lima',
    fecha         : new Date().toISOString().slice(0,10) + ' (HOY)',
    horario       : '08:30 - 12:30',
    bw            : '10 Mbps',
    cambio_cpe    : 'FG-70G',
    maps_link     : 'https://www.google.com/maps?q=-12.1835,-76.9516',
    mensaje       : '✅ Correo de prueba del sistema Gestión de Trabajos – Entel.',
  };
  try {
    await emailjs.send(cfg.serviceId, cfg.templateId, params);
    alert('✅ Correo de prueba enviado a ' + params.tecnico_email + '\nRevisa tu bandeja de entrada.');
  } catch(e){
    alert('❌ Error al enviar: ' + JSON.stringify(e));
  }
}
function addTecnico(){
  const nombre = document.getElementById('tecNombre').value.trim();
  const cel = document.getElementById('tecCel').value.trim();
  const correo = document.getElementById('tecCorreo').value.trim();
  const dpto = document.getElementById('tecDpto').value;
  const waKey = document.getElementById('tecWaKey').value.trim();
  if(!nombre){ alert('Ingresa el nombre del técnico.'); return; }
  state.tecnicos.push({ nombre, cel, correo, dpto, waKey });
  saveState();
  ['tecNombre','tecCel','tecCorreo','tecWaKey'].forEach(id=>document.getElementById(id).value='');
  renderTecnicos(); populateTecnicoFilter();
}
function removeTecnico(i){ state.tecnicos.splice(i,1); saveState(); renderTecnicos(); populateTecnicoFilter(); }
function editTecnico(i){
  const t = state.tecnicos[i];
  const nombre = prompt('Nombre:', t.nombre); if(nombre===null) return;
  const cel = prompt('Celular (WhatsApp):', t.cel)||'';
  const correo = prompt('Correo:', t.correo)||'';
  const waKey = prompt('API Key WhatsApp (CallMeBot):', t.waKey||'')||'';
  state.tecnicos[i] = Object.assign({}, t, {nombre, cel, correo, waKey});
  saveState(); renderTecnicos(); populateTecnicoFilter();
}
function renderTecnicos(){
  const rows = currentData().map(getRow);
  const list = document.getElementById('tecList');
  if(!state.tecnicos.length){ list.innerHTML = `<div class="empty">Sin técnicos registrados.</div>`; return; }
  list.innerHTML = state.tecnicos.map((t,i)=>{
    const propios = rows.filter(r=>r.tecnico===t.nombre);
    const pend = propios.filter(r=>r.estado==='PENDIENTE'||r.estado==='EN_PROCESO').length;
    const comp = propios.filter(r=>r.estado==='COMPLETADO').length;
    const pct = propios.length ? Math.round(comp/propios.length*100) : 0;
    return `<div class="tec-card">
      <div class="name">👤 ${t.nombre}</div>
      <div class="meta">📍 ${t.dpto||'General'} · 📱 ${t.cel||'-'}<br>✉ ${t.correo||'-'}<br>
        ${t.waKey ? `<span style="color:var(--green);font-size:11px;">✅ WhatsApp activo</span>` : `<span style="color:var(--muted);font-size:11px;">⚠️ Sin API Key WhatsApp</span>`}
      </div>
      <div class="tec-stats">
        <div class="trabajos"><div class="n">${propios.length}</div><div class="l">trabajos</div></div>
        <div class="pendientes"><div class="n">${pend}</div><div class="l">pendientes</div></div>
        <div class="completados"><div class="n">${comp}</div><div class="l">completados</div></div>
      </div>
      <div class="tec-pct">${pct}% completado</div>
      <div class="tec-progress"><div style="width:${pct}%"></div></div>
      <div class="tec-actions">
        <button class="btn secondary" onclick="editTecnico(${i})">✏ Editar</button>
        <button class="btn danger" onclick="removeTecnico(${i})">🗑 Eliminar</button>
      </div>
    </div>`;
  }).join('');
}

// ---------------- USUARIOS ----------------
function addUsuario(){
  const nombre = document.getElementById('usrNombre').value.trim();
  const correo = document.getElementById('usrCorreo').value.trim().toLowerCase();
  const pass   = document.getElementById('usrPass').value.trim();
  const rol    = document.getElementById('usrRol').value;

  if(!nombre || !correo || !pass){ alert('Completa todos los campos.'); return; }
  if(pass.length < 6){ alert('La contraseña debe tener mínimo 6 caracteres.'); return; }
  if(state.usuarios.some(u => u.correo.trim().toLowerCase() === correo)){
    alert('Ese correo ya está registrado.'); return;
  }

  state.usuarios.push({ nombre, correo, pass, rol });
  saveUsers();  // ← Guarda en clave propia (nunca se pierde)
  saveState();  // ← Guarda estado general

  ['usrNombre','usrCorreo','usrPass'].forEach(id => document.getElementById(id).value = '');
  renderUsuarios();
  alert(`✅ Usuario creado correctamente.\n\nCorreo: ${correo}\nContraseña: ${pass}\nRol: ${rol}\n\nGuarda estos datos — el usuario puede iniciar sesión ahora.`);
}

function removeUsuario(i){
  if(state.usuarios.length <= 1){ alert('Debe existir al menos un usuario.'); return; }
  const u = state.usuarios[i];
  if(!confirm(`¿Eliminar el usuario "${u.correo}"?`)) return;
  state.usuarios.splice(i, 1);
  saveUsers();  // ← Guarda en clave propia
  saveState();
  renderUsuarios();
}

function changeRol(i, rol){
  state.usuarios[i].rol = rol;
  saveUsers();  // ← Guarda en clave propia
  saveState();
}
function renderUsuarios(){
  const list = document.getElementById('usrList');
  list.innerHTML = state.usuarios.map((u,i)=>`
    <div class="usr-card rol-${u.rol.replace(' ','_')}">
      <div class="name">${u.nombre}</div>
      <div class="mail">${u.correo}</div>
      <select onchange="changeRol(${i}, this.value)">
        <option ${u.rol==='Administrador'?'selected':''}>Administrador</option>
        <option ${u.rol==='Supervisor'?'selected':''}>Supervisor</option>
        <option ${u.rol==='Solo lectura'?'selected':''}>Solo lectura</option>
      </select>
      <div style="display:flex;gap:8px;">
        <button class="btn secondary" style="flex:1" onclick="editUsuario(${i})">✏ Editar</button>
        <button class="btn danger" style="flex:1" onclick="removeUsuario(${i})">🗑 Eliminar</button>
      </div>
    </div>`).join('');
}
function editUsuario(i){
  const u = state.usuarios[i];
  const nombre = prompt('Nombre:', u.nombre); if(nombre===null) return;
  const correo = prompt('Correo:', u.correo)||u.correo;
  state.usuarios[i] = Object.assign({}, u, {nombre, correo});
  saveState(); renderUsuarios();
}

// ---------------- NOTIFICACIONES ----------------
function renderNotif(){
  const list = document.getElementById('notifList');
  list.innerHTML = state.notif.length ? state.notif.slice(0,60).map(n=>`<div class="hist-item"><span class="ts">${n.ts}</span><br>${n.msg}</div>`).join('')
    : '<div class="empty">Sin notificaciones todavía. Se generan al asignar técnicos o cambiar estados.</div>';
}
function generarResumen(){
  const rows = currentData().map(getRow).filter(r=>daysDiff(r.fechaMigr)===0);
  alert(rows.length ? `Resumen de hoy (${rows.length} trabajos):\n` + rows.map(r=>`OIT ${r.oit} - ${r.distrito} - ${r.tecnico||'Sin asignar'}`).join('\n') : 'No hay trabajos programados para hoy.');
}

// ---------------- PROGRAMACIONES (semana) ----------------
function getWeekDates(offset){
  const now = new Date(); now.setHours(0,0,0,0);
  const day = now.getDay(); // 0 dom .. 6 sab
  const diffToMonday = (day===0?-6:1-day);
  const monday = new Date(now); monday.setDate(now.getDate()+diffToMonday+offset*7);
  return Array.from({length:7}, (_,i)=>{ const d=new Date(monday); d.setDate(monday.getDate()+i); return d; });
}
function fmtDate(d){ return d.toISOString().slice(0,10); }
function shiftWeek(dir){ weekOffset += dir; renderWeek(); }
function goToday(){ weekOffset = 0; renderWeek(); }

function renderWeek(){
  const dates = getWeekDates(weekOffset);
  const todayStr = fmtDate(new Date());
  const rangeTxt = `${dates[0].toLocaleDateString('es-PE',{day:'2-digit',month:'long'})} – ${dates[6].toLocaleDateString('es-PE',{day:'2-digit',month:'long',year:'numeric'})}`;
  document.getElementById('weekRange').textContent = rangeTxt;

  const rows = currentData().map(getRow);
  const weekRows = rows.filter(r=>r.fechaMigr && dates.some(d=>fmtDate(d)===r.fechaMigr));

  document.getElementById('progTotal').textContent = weekRows.length;
  document.getElementById('progComp').textContent = weekRows.filter(r=>r.estado==='COMPLETADO').length;
  document.getElementById('progProc').textContent = weekRows.filter(r=>r.estado==='EN_PROCESO').length;
  document.getElementById('progPend').textContent = weekRows.filter(r=>r.estado==='PENDIENTE').length;
  document.getElementById('progSinTec').textContent = weekRows.filter(r=>!r.tecnico).length;

  const dayNames = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
  const grid = document.getElementById('weekGrid');
  grid.innerHTML = dates.map((d,i)=>{
    const ds = fmtDate(d);
    const items = weekRows.filter(r=>r.fechaMigr===ds);
    const isToday = ds===todayStr;
    const cards = items.length ? items.map(r=>{
      const pct = [r.acta,r.guia,r.informe].filter(Boolean).length/3*100;
      const color = r.estado==='COMPLETADO'?'var(--green)':r.estado==='VENCIDO'?'var(--red)':r.estado==='EN_PROCESO'?'var(--cyan)':'var(--muted2)';
      return `<div class="day-card ${r.estado}">
        <div class="o">${r.oit}</div>
        <div class="m">${r.distrito}<br>👤 ${r.tecnico?r.tecnico.split(' ')[0]:'-'} · ${r.horario||'-'}</div>
        <div class="bar"><div style="width:${pct}%;background:${color}"></div></div>
      </div>`;
    }).join('') : `<div class="day-empty">Sin OITs</div>`;
    return `<div class="day-col ${isToday?'today':''}">
      <div class="dh"><span>${dayNames[i]} ${d.getDate()}</span><span>${items.length}</span></div>
      ${cards}
    </div>`;
  }).join('');

  const detailBody = document.getElementById('weekDetailBody');
  if(!weekRows.length){ detailBody.innerHTML = `<tr><td colspan="7" class="empty">Sin trabajos esta semana.</td></tr>`; return; }
  detailBody.innerHTML = weekRows.sort((a,b)=>(a.fechaMigr||'').localeCompare(b.fechaMigr||'')).map(r=>{
    const pct = Math.round([r.acta,r.guia,r.informe].filter(Boolean).length/3*100);
    return `<tr>
      <td>${r.fechaMigr}</td><td>${r.oit}</td><td>${r.distrito}</td><td>${r.horario||'-'}</td>
      <td>${r.tecnico||'Sin asignar'}</td><td><span class="badge ${r.estado}">${r.estado.replace('_',' ')}</span></td>
      <td style="min-width:90px"><div class="eprogress"><div style="width:${pct}%"></div></div>${pct}%</td>
    </tr>`;
  }).join('');
}

// ---------------- BOOT ----------------
window.addEventListener('DOMContentLoaded', ()=>{
  // Si no hay config guardada aún, guardar las credenciales conocidas automáticamente
  let cfg = getConfig();
  if(!cfg.emailJsKey){
    cfg = Object.assign(cfg, {
      emailJsKey   : '_w0TN7D8axIDoqGPV',
      serviceId    : 'service_xgd1236',
      templateId   : 'template_g2cbtxs',
      appsScriptUrl: 'https://script.google.com/macros/s/AKfycbz4lYU5ISigWTc9lzvidvmyp3cHRfuM8t8EvAnmLKGebrvaQJPGAiOXZ90pr581KY2bKg/exec',
    });
    localStorage.setItem('spsa_notif_config', JSON.stringify(cfg));
  }
  try { emailjs.init(cfg.emailJsKey); } catch(e){}
  updateConfigStatus(cfg);

  if(state.currentUser){
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('userTag').textContent = `${state.currentUser.nombre} · ${state.currentUser.rol}`;
    init();
    // Cargar datos desde Google Sheets (no bloquea el inicio)
    loadFromSheets();
    // Auto-sincronizar cada 60 segundos
    setInterval(loadFromSheets, 60000);
  }
});

// ════════════════════════════════════════════════════════════
//  INTEGRACIÓN GOOGLE SHEETS
//  loadFromSheets()  → lee datos del Sheet y reemplaza RAW_DATA
//  pushToSheet()     → envía cambios de vuelta al Sheet
//  updateSheetsStatusBadge() → actualiza indicador visual
// ════════════════════════════════════════════════════════════

async function loadFromSheets(){
  const cfg = getConfig();
  const url = cfg.appsScriptUrl || cfg.sheetsUrl;
  if(!url){ updateSheetsStatusBadge(false,'Sin URL configurada'); return; }

  try {
    updateSheetsStatusBadge(null,'Sincronizando…');
    const resp = await fetch(url, { method:'GET', cache:'no-cache' });
    if(!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if(data.error) throw new Error(data.error);
    if(!data['PP.EE'] || !data['RR.EE']) throw new Error('Formato inesperado');

    LIVE_DATA = data;
    sheetsLastSync = new Date();
    sheetsSyncError = false;

    // ── Sincronizar campos del Sheet hacia los overrides de localStorage ──
    // Esto asegura que los valores actuales del Sheet (estado, técnico, fechaMigr,
    // etc.) reemplacen valores stale que quedaron del período pre-Sheets.
    syncSheetIntoOverrides();

    updateSheetsStatusBadge(true, 'Google Sheets · ' + sheetsLastSync.toLocaleTimeString('es-PE'));

    populateDeptoFilter();
    populateMesSelect();
    populateTecnicoFilter();
    renderTabla();
    renderAlertas();
    renderTecnicos();
    renderWeek();

  } catch(e){
    sheetsSyncError = true;
    updateSheetsStatusBadge(false, 'Error: ' + (e.message||'sin conexión') + ' — usando datos locales');
  }
}

// Escribe los valores del Sheet en los overrides de localStorage para los
// campos que vienen del Sheet. Así los overrides "stale" son reemplazados
// por los valores actuales. Los campos que el usuario edita desde el dashboard
// son empujados al Sheet inmediatamente (pushToSheet), por lo que en el
// próximo sync el Sheet ya tendrá el valor correcto.
function syncSheetIntoOverrides(){
  if(!LIVE_DATA) return;
  // Solo sincronizar campos operativos (los que el usuario edita).
  // Los base fields SIEMPRE vienen de raw data — no necesitan override.
  const SYNC_FIELDS = [
    'estado','tecnico','fechaMigr','fechaAsignada','supervEntel',
    'tipoTrabajo','trabajoRealizar','tipoOit',
    'acta','guia','informe',
    'guiaInstN','guiaInstS','guiaDesN','guiaDesS',
    'bw','cambioCpe'
  ];
  let changed = false;
  ['PP.EE','RR.EE'].forEach(base => {
    (LIVE_DATA[base] || []).forEach(sheetRow => {
      const key = rowKey(sheetRow);
      const ov  = state.overrides[key];
      if(!ov) return;
      SYNC_FIELDS.forEach(f => {
        const sv = sheetRow[f];
        if(sv !== null && sv !== undefined && sv !== '') {
          ov[f] = sv; changed = true;
        }
      });
    });
  });
  if(changed) saveState();
}

// Envía los cambios de UNA OIT al Sheet (fire & don't block UI)
async function pushToSheet(key, changes){
  const cfg = getConfig();
  const url = cfg.appsScriptUrl || cfg.sheetsUrl;
  if(!url) return;

  const [tipoBase, oit] = key.split('|');
  // Filtrar campos internos que no van al Sheet
  const cleanChanges = Object.fromEntries(
    Object.entries(changes).filter(([k])=>!k.startsWith('_') && k !== 'comentarios' && k !== 'custom')
  );
  if(!Object.keys(cleanChanges).length) return;

  try {
    await fetch(url, {
      method : 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body   : JSON.stringify({ action:'update', tipoBase, oit:String(oit), changes:cleanChanges }),
    });
  } catch(e){
    console.warn('Push to Sheet falló:', e.message);
  }
}

async function testSheetsConnection(){
  const url = document.getElementById('cfgAppsScriptUrl')?.value?.trim() || getConfig().appsScriptUrl;
  if(!url){ alert('Primero ingresa la URL del Apps Script.'); return; }
  const btn = event.target;
  btn.textContent = '⏳ Probando…';
  try {
    const resp = await fetch(url, { method:'GET', cache:'no-cache' });
    const data = await resp.json();
    if(data['PP.EE'] && data['RR.EE']){
      alert(`✅ Conexión exitosa!\n\nPP.EE: ${data['PP.EE'].length} registros\nRR.EE: ${data['RR.EE'].length} registros\nÚltima actualización: ${new Date(data.timestamp).toLocaleString('es-PE')}`);
    } else if(data.error){
      alert('❌ Error del servidor: ' + data.error);
    } else {
      alert('⚠️ Respuesta inesperada del servidor.');
    }
  } catch(e){
    alert('❌ No se pudo conectar: ' + e.message + '\n\nVerifica que la URL sea correcta y que el Apps Script esté publicado como "Cualquier persona".');
  } finally {
    btn.textContent = '🧪 Probar conexión Sheets';
  }
}

async function forceSheetsSync(){
  await loadFromSheets();
  if(!sheetsSyncError){
    alert('✅ Sincronización completada. Dashboard actualizado con los datos del Google Sheet.');
  } else {
    alert('❌ Error al sincronizar. Revisa la URL del Apps Script y la conexión a internet.');
  }
}

function updateSheetsStatusBadge(ok, msg){
  const badge = document.getElementById('sheetsSyncBadge');
  if(!badge) return;
  if(ok === null){
    badge.innerHTML = `<span style="color:var(--orange)">🔄 ${msg}</span>`;
  } else if(ok){
    badge.innerHTML = `<span style="color:var(--green2)">🟢 ${msg}</span>`;
  } else {
    badge.innerHTML = `<span style="color:var(--red)" title="${msg}">🔴 Sheets desconectado</span>`;
  }
}

