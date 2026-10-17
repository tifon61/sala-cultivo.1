// Página del celular. Pide datos a la API del backend (mismo servidor) y los dibuja.
//   GET  /api/salas                      -> todas las salas: lecturas, equipos, etapa (cada 5 s)
//   GET  /api/salas/<id>/historico       -> series para los gráficos (cada 60 s)
//   GET  /api/salas/<id>/bitacora        -> registro de la sala
//   POST /api/salas/<id>/reles/<rele>/…  -> control manual / automático / reglas

const VARIABLES = {
  temperatura:  { nombre: 'Temp DHT',   unidad: '°C',  dec: 1 },
  humedad:      { nombre: 'Hum DHT',    unidad: '%',   dec: 1 },
  dpv:          { nombre: 'DPV',        unidad: 'kPa', dec: 2 },
  co2:          { nombre: 'CO₂',        unidad: 'ppm', dec: 0 },
  temperatura2: { nombre: 'Temp SCD40', unidad: '°C',  dec: 1 },
  humedad2:     { nombre: 'Hum SCD40',  unidad: '%',   dec: 1 },
  rssi:         { nombre: 'Wi-Fi',      unidad: 'dBm', dec: 0 },
};
// Variables del esquema, de a pares (izquierda | derecha) para comparar los dos sensores.
const EN_PLANO = ['temperatura', 'temperatura2', 'humedad', 'humedad2', 'dpv', 'co2'];
const ICONOS = { luz: '💡', riego: '💧', humidificador: '💨', deshumidificador: '🌀', extractor: '🌬️' };
const ETAPAS = { germinacion: 'Germinación', plantines: 'Plantines', vegetativo: 'Vegetativo', floracion: 'Floración',
                 secado: 'Secado', curado: 'Curado', vacia: 'Vacía' };
const TIPOS = { etapa: 'Etapa', nota: 'Nota', riego_nutrientes: 'Riego con nutrientes', poda: 'Poda',
                trasplante: 'Trasplante', plaga: 'Plaga', cosecha: 'Cosecha', mantenimiento: 'Mantenimiento' };
// Un color fijo por variable (el mismo en todos los gráficos y períodos).
// Los pares que comparten gráfico (DHT vs SCD40) se verificaron para que se
// distingan también con daltonismo; además el SCD40 va con línea punteada.
const COLOR_VARIABLE = {
  temperatura: '#d95926',   // naranja
  temperatura2: '#9085e9',  // violeta
  humedad: '#3987e5',       // azul
  humedad2: '#199e70',      // turquesa
  dpv: '#d55181',           // magenta
  co2: '#c98500',           // amarillo
};
const PUNTEADAS = new Set(['temperatura2', 'humedad2']);
const COLOR_OTRA = '#94a3b8';

// Unidad del DPV: el sistema guarda todo en kPa; la conversión es solo para mostrar.
// 1 kPa = 10 hPa.
let unidadDpv = 'kPa';
try { unidadDpv = localStorage.getItem('unidadDpv') === 'hPa' ? 'hPa' : 'kPa'; } catch {}
const factorDpv = () => (unidadDpv === 'hPa' ? 10 : 1);

function info(v) {
  if (v === 'dpv') return { nombre: 'DPV', unidad: unidadDpv, dec: unidadDpv === 'hPa' ? 1 : 2 };
  return VARIABLES[v] || { nombre: v, unidad: '', dec: 2 };
}
// Valor tal como se muestra (convierte el DPV si hace falta).
const mostrar = (v, valor) => (v === 'dpv' ? valor * factorDpv() : valor);
// Los motivos que manda el ESP32 vienen en kPa ("dpv 1.02 < 1.10"): los convertimos.
function motivoMostrado(texto) {
  if (unidadDpv !== 'hPa' || !texto.startsWith('dpv ')) return texto;
  return texto.replace(/\d+\.\d+/g, n => (Number(n) * 10).toFixed(1)) + ' hPa';
}
const $ = sel => document.querySelector(sel);
const hora = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fechaCorta = ts => new Date(ts).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

let datos = null;          // última respuesta de /api/salas
let elegida = localStorage.getItem('sala') || null;

async function api(metodo, ruta, cuerpo) {
  const res = await fetch(ruta, {
    method: metodo,
    headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detalle = Array.isArray(r.detail) ? r.detail.map(d => d.msg.replace('Value error, ', '')).join('; ') : r.detail;
    throw new Error(detalle || `error ${res.status}`);
  }
  return r;
}

function sala() { return datos?.salas.find(s => s.id === elegida); }

// "en 3 h 12 min" a partir de una fecha futura
function cuentaRegresiva(cuando) {
  const s = Math.max(0, Math.round((new Date(cuando) - Date.now()) / 1000));
  if (s < 60) return `en ${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `en ${min} min`;
  return `en ${Math.floor(min / 60)} h ${min % 60} min`;
}

function textoEtapa(s) {
  if (!s.etapa) return 'sin etapa';
  const semana = Math.ceil(s.dia_etapa / 7);
  return `${ETAPAS[s.etapa] || s.etapa} · día ${s.dia_etapa} (sem ${semana})`;
}

// ----------------------------------------------------------------- refresco

async function actualizar() {
  try {
    datos = await api('GET', '/api/salas');
  } catch {
    pintarConexion(false, 'sin conexión al servidor');
    return;
  }
  if (!sala()) elegirSala(datos.salas[0]?.id, false);
  pintarConexion(datos.mqtt_conectado, datos.mqtt_conectado ? 'servidor ok' : 'servidor sin broker MQTT');
  pintarPlano();
  pintarPestanas();
  pintarDetalle();
}

function pintarConexion(ok, texto) {
  $('#conexion').className = 'conexion ' + (ok ? 'ok' : 'mal');
  $('#conexion-texto').textContent = texto;
}

// ------------------------------------------------------------------ esquema

function pintarPlano() {
  const plano = $('#plano');
  plano.replaceChildren(...datos.salas.map(s => {
    const caja = document.createElement('div');
    caja.className = 'sala-plano' + (s.id === elegida ? ' elegida' : '');
    caja.onclick = () => elegirSala(s.id);

    const titulo = document.createElement('div');
    titulo.className = 'titulo';
    titulo.innerHTML = `<span class="punto ${s.online ? 'ok' : 'mal'}"></span><span></span>`;
    titulo.lastChild.textContent = s.nombre;
    const etapa = document.createElement('span');
    etapa.className = 'etapa ' + (s.etapa || '');
    etapa.textContent = textoEtapa(s);

    const vars = document.createElement('div');
    vars.className = 'variables';
    for (const v of EN_PLANO) {
      const l = s.lecturas[v];
      const d = document.createElement('div');
      d.className = 'variable' + (!l || l.viejo ? ' vieja' : '');
      d.innerHTML = '<small></small><b></b><span class="unidad"></span>';
      d.children[0].textContent = info(v).nombre;
      d.children[1].textContent = l ? mostrar(v, l.valor).toFixed(info(v).dec) : '—';
      d.children[2].textContent = l ? info(v).unidad : '';
      vars.append(d);
    }

    const equipos = document.createElement('div');
    equipos.className = 'equipos';
    const proximos = document.createElement('ul');
    proximos.className = 'proximos';
    for (const r of s.reles) {
      const e = document.createElement('div');
      e.className = 'equipo' + (r.on ? ' on' : '');
      e.title = motivoMostrado(r.motivo);
      e.innerHTML = '<span class="icono"></span><span class="nombre-eq"></span>';
      e.firstChild.textContent = ICONOS[r.id] || '⚙️';
      e.lastChild.textContent = `${r.nombre}${r.manual_vigente ? ' ✋' : ''}`;
      equipos.append(e);
      if (r.proximo) {
        const li = document.createElement('li');
        li.innerHTML = '<span></span> <span></span> · <b data-cuando></b>';
        li.children[0].textContent = ICONOS[r.id] || '⚙️';
        li.children[1].textContent = r.proximo.texto;
        li.children[2].dataset.cuando = r.proximo.cuando;
        li.children[2].textContent = cuentaRegresiva(r.proximo.cuando);
        proximos.append(li);
      }
    }
    caja.append(titulo, etapa, vars, equipos, proximos);
    return caja;
  }));
}

// Las cuentas regresivas se actualizan cada segundo sin pedir nada al servidor.
setInterval(() => {
  document.querySelectorAll('[data-cuando]').forEach(el => { el.textContent = cuentaRegresiva(el.dataset.cuando); });
}, 1000);

// ------------------------------------------------------------ sala elegida

function elegirSala(id, recargar = true) {
  if (!id) return;
  if (id !== elegida) {
    elegida = id;
    try { localStorage.setItem('sala', id); } catch {}
    $('#reles').replaceChildren();
    Object.keys(tarjetas).forEach(k => delete tarjetas[k]);
  }
  if (recargar && datos) {
    pintarPlano(); pintarPestanas(); pintarDetalle();
    actualizarHistorico(); actualizarBitacora();
  }
}

function pintarPestanas() {
  $('#pestanas').replaceChildren(...datos.salas.map(s => {
    const b = document.createElement('button');
    b.textContent = s.nombre;
    b.className = s.id === elegida ? 'activo' : '';
    b.onclick = () => elegirSala(s.id);
    return b;
  }));
}

function pintarDetalle() {
  const s = sala();
  if (!s) return;
  const m = s.modulo;
  const partes = [s.online ? `Módulo conectado · último dato ${s.ultimo_dato ? hora(s.ultimo_dato) : '—'}` : 'Módulo DESCONECTADO (sigue funcionando solo con su última configuración)'];
  if (m.version_aplicada != null && m.version_aplicada !== m.version_servidor) partes.push('<span class="alerta">configuración pendiente de llegar al módulo</span>');
  if (m.config_local) partes.push('<span class="alerta">cambiada desde la red local del módulo</span>');
  if (m.modo_ap) partes.push('<span class="alerta">red de emergencia activa</span>');
  if (m.hay_hora === false) partes.push('<span class="alerta">el módulo no tiene hora</span>');
  if (m.pendientes) partes.push(`${m.pendientes} mediciones guardadas por enviar`);
  if (m.error) partes.push(`<span class="alerta">error: ${m.error.replace(/</g, '&lt;')}</span>`);
  $('#modulo').innerHTML = partes.join(' · ');
  pintarReles(s);
}

// ------------------------------------------------------------------ equipos
// Cada tarjeta se crea una sola vez; después solo se actualizan sus textos,
// así no se cierra el formulario de la regla mientras lo estás editando.

const tarjetas = {};

function pintarReles(s) {
  for (const r of s.reles) {
    if (!tarjetas[r.id]) {
      tarjetas[r.id] = crearTarjetaRele(s.id, r);
      $('#reles').append(tarjetas[r.id]);
    }
    const t = tarjetas[r.id];
    t.querySelector('.rele-nombre').textContent = `${ICONOS[r.id] || '⚙️'} ${r.nombre}`;
    t.querySelector('.rele-motivo').textContent = motivoMostrado(r.motivo);
    const pastilla = t.querySelector('.pastilla');
    pastilla.textContent = r.on == null ? '—' : (r.on ? 'ENCENDIDO' : 'APAGADO');
    pastilla.classList.toggle('on', !!r.on);
    t.querySelector('[data-accion=auto]').classList.toggle('activo', !r.manual_vigente);
    t.querySelector('[data-accion=on]').classList.toggle('activo', r.manual_vigente && r.manual_estado);
    t.querySelector('[data-accion=off]').classList.toggle('activo', r.manual_vigente && !r.manual_estado);
  }
}

function crearTarjetaRele(sid, rele) {
  const t = $('#tpl-rele').content.firstElementChild.cloneNode(true);
  t.querySelectorAll('[data-accion]').forEach(boton => {
    boton.addEventListener('click', async () => {
      const accion = boton.dataset.accion;
      const minutos = parseInt(t.querySelector('.duracion').value) || null;
      boton.disabled = true;
      try {
        if (accion === 'auto') await api('POST', `/api/salas/${sid}/reles/${rele.id}/auto`);
        else await api('POST', `/api/salas/${sid}/reles/${rele.id}/manual`, { encendido: accion === 'on', minutos });
        await actualizar();
      } catch (e) {
        alert('No se pudo cambiar: ' + e.message);
      } finally {
        boton.disabled = false;
      }
    });
  });
  armarFormularioRegla(t.querySelector('.form-regla'), sid, rele.id, rele.regla);
  return t;
}

// Campos de cada tipo de regla: [clave, etiqueta, tipo de input]
const CAMPOS = {
  horario: [['encender', 'Encender a las', 'time'], ['apagar', 'Apagar a las', 'time']],
  umbral: [
    ['variable', 'Variable', 'variable'],
    ['encender_si', 'Encender si es', 'comparacion'],
    ['valor', 'Umbral', 'number'],
    ['histeresis', 'Histéresis', 'number'],
  ],
  pulsos: [
    ['encendido_s', 'Segundos encendido', 'number'],
    ['cada_min', 'Cada (minutos)', 'number'],
    ['desde', 'Desde (opcional)', 'time'],
    ['hasta', 'Hasta (opcional)', 'time'],
  ],
};
const AYUDA = {
  horario: 'Puede cruzar la medianoche (ej. 18:00 a 06:00).',
  umbral: 'DPV alto = aire seco → humidificador "mayor". DPV bajo = aire húmedo → deshumidificador "menor".',
  pulsos: 'Los pulsos se cuentan desde la hora "desde". Sin ventana, todo el día desde las 00:00.',
};

function armarFormularioRegla(form, sid, rid, regla) {
  form.replaceChildren();
  const tipo = crearCampo(form, 'Tipo', 'select', 'ancho');
  for (const [valor, texto] of [['horario', 'Horario'], ['umbral', 'Umbral (sensor)'], ['pulsos', 'Pulsos de tiempo']]) {
    tipo.add(new Option(texto, valor, false, valor === regla.tipo));
  }
  tipo.addEventListener('change', () => armarFormularioRegla(form, sid, rid, { tipo: tipo.value }));

  for (const [clave, etiqueta, clase] of CAMPOS[regla.tipo]) {
    let input;
    if (clase === 'variable') {
      input = crearCampo(form, etiqueta, 'select');
      for (const v of ['dpv', 'temperatura', 'humedad', 'co2', 'temperatura2', 'humedad2']) input.add(new Option(info(v).nombre, v));
    } else if (clase === 'comparacion') {
      input = crearCampo(form, etiqueta, 'select');
      input.add(new Option('mayor al umbral', 'mayor'));
      input.add(new Option('menor al umbral', 'menor'));
    } else {
      input = crearCampo(form, etiqueta, 'input');
      input.type = clase;
      if (clase === 'number') input.step = 'any';
    }
    input.name = clave;
    if (regla[clave] != null) input.value = regla[clave];
  }
  // Umbral de DPV: se edita en la unidad elegida y se guarda en kPa.
  const enDpv = regla.tipo === 'umbral' && (regla.variable || 'dpv') === 'dpv';
  if (enDpv) {
    for (const k of ['valor', 'histeresis']) {
      const campo = form.elements[k];
      if (campo.value !== '') campo.value = +(Number(campo.value) * factorDpv()).toFixed(3);
      campo.previousSibling.textContent += ` (${unidadDpv})`;
    }
  }
  // Al cambiar la variable de un umbral se rearma el formulario: así los
  // números y la unidad corresponden siempre a la variable elegida.
  if (regla.tipo === 'umbral') {
    form.elements.variable.onchange = () => armarFormularioRegla(form, sid, rid, {
      tipo: 'umbral', variable: form.elements.variable.value, encender_si: form.elements.encender_si.value,
    });
  }

  const ayuda = document.createElement('p');
  ayuda.className = 'ayuda ancho';
  ayuda.textContent = AYUDA[regla.tipo];
  const error = document.createElement('p');
  error.className = 'error ancho';
  const guardar = document.createElement('button');
  guardar.className = 'ancho';
  guardar.textContent = 'Guardar regla';
  form.append(ayuda, error, guardar);

  form.onsubmit = async ev => {
    ev.preventDefault();
    const nueva = { tipo: tipo.value };
    for (const [clave, , clase] of CAMPOS[tipo.value]) {
      const valor = form.elements[clave].value;
      if (valor === '') continue;
      nueva[clave] = clase === 'number' ? Number(valor) : valor;
    }
    if (enDpv && nueva.variable === 'dpv') {
      for (const k of ['valor', 'histeresis']) if (k in nueva) nueva[k] = +(nueva[k] / factorDpv()).toFixed(4);
    }
    try {
      await api('PUT', `/api/salas/${sid}/reles/${rid}/regla`, nueva);
      error.textContent = '';
      form.closest('details').open = false;
      await actualizar();
    } catch (e) {
      error.textContent = 'Regla inválida: ' + e.message;
    }
  };
}

function crearCampo(form, etiqueta, etiquetaHtml, clase) {
  const label = document.createElement('label');
  if (clase) label.className = clase;
  label.textContent = etiqueta;
  const input = document.createElement(etiquetaHtml);
  label.append(input);
  form.append(label);
  return input;
}

// ----------------------------------------------------------------- gráficos
// Un gráfico por unidad (°C, %, kPa, ppm...), así las escalas tienen sentido.

const graficos = {};

async function actualizarHistorico() {
  if (!elegida) return;
  const periodo = $('#periodo').value;
  let consulta;
  if (periodo === 'rango') {
    const desde = $('#desde').value, hasta = $('#hasta').value;
    if (!desde || !hasta) return;  // falta elegir alguna fecha
    // Fechas sin zona horaria: el servidor las toma en su hora local.
    consulta = `desde=${desde}T00:00:00&hasta=${hasta}T23:59:59`;
  } else {
    consulta = `horas=${periodo}`;
  }
  let h;
  try {
    h = await api('GET', `/api/salas/${elegida}/historico?${consulta}`);
    $('#error-periodo').textContent = '';
  } catch (e) {
    $('#error-periodo').textContent = e.message;
    return;
  }

  const porUnidad = {};
  for (const [variable, puntos] of Object.entries(h.series)) {
    if (variable === 'rssi') continue;
    (porUnidad[info(variable).unidad] ||= []).push([variable, puntos]);
  }
  const cont = $('#graficos');
  for (const unidad of Object.keys(graficos)) {
    if (!porUnidad[unidad]) {
      const caja = graficos[unidad].canvas.parentElement;  // antes de destroy(), que lo borra
      graficos[unidad].destroy();
      caja.remove();
      delete graficos[unidad];
    }
  }
  cont.querySelector('.vacio')?.remove();
  if (!Object.keys(porUnidad).length) cont.insertAdjacentHTML('beforeend', '<p class="vacio">Sin datos en este período.</p>');

  const conFecha = new Date(h.hasta) - new Date(h.desde) > 36 * 3600 * 1000;
  const ejeX = { min: new Date(h.desde).getTime(), max: new Date(h.hasta).getTime() };
  for (const [unidad, series] of Object.entries(porUnidad)) {
    // Primero el DHT y después el SCD40, siempre en el mismo orden.
    series.sort(([a], [b]) => a.localeCompare(b));
    const datasets = series.map(([variable, puntos]) => ({
      label: info(variable).nombre,
      data: puntos.map(([t, v]) => ({ x: new Date(t).getTime(), y: mostrar(variable, v) })),
      borderColor: COLOR_VARIABLE[variable] || COLOR_OTRA,
      backgroundColor: COLOR_VARIABLE[variable] || COLOR_OTRA,
      borderDash: PUNTEADAS.has(variable) ? [6, 4] : [],
      borderWidth: 2, pointRadius: 0, tension: 0.25,
    }));
    if (graficos[unidad]) {
      graficos[unidad].data.datasets = datasets;
      Object.assign(graficos[unidad].options.scales.x, ejeX);
      graficos[unidad].options.scales.x.ticks.callback = etiquetaTiempo(conFecha);
      graficos[unidad].update('none');
      continue;
    }
    const caja = document.createElement('div');
    caja.className = 'grafico';
    const canvas = document.createElement('canvas');
    caja.append(canvas);
    cont.append(caja);
    graficos[unidad] = new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: {
        animation: false, maintainAspectRatio: false, parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: { type: 'linear', ...ejeX, ticks: { color: '#94a3b8', maxTicksLimit: 6, callback: etiquetaTiempo(conFecha) }, grid: { color: '#1e293b' } },
          y: { title: { display: true, text: unidad, color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' } },
        },
        plugins: {
          legend: { labels: { color: '#f1f5f9', boxWidth: 12 } },
          tooltip: { callbacks: { title: items => new Date(items[0].parsed.x).toLocaleString() } },
        },
      },
    });
  }
  // Orden fijo de los gráficos: temperatura, humedad, DPV, CO2 y después el resto.
  const orden = u => ['°C', '%', 'kPa', 'hPa', 'ppm'].indexOf(u) + 1 || 99;
  Object.keys(graficos).sort((a, b) => orden(a) - orden(b))
    .forEach(u => cont.append(graficos[u].canvas.parentElement));
  pintarEventos(h.eventos);
}

function etiquetaTiempo(conFecha) {
  return valor => conFecha ? new Date(valor).toLocaleDateString([], { day: '2-digit', month: '2-digit' }) : hora(valor);
}

function pintarEventos(eventos) {
  const lista = $('#eventos');
  lista.replaceChildren();
  if (!eventos.length) { lista.innerHTML = '<li>Sin cambios en este período.</li>'; return; }
  for (const e of eventos.slice(0, 30)) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span> · <b></b> → <b></b> <span></span>';
    li.children[0].textContent = fechaCorta(e.ts);
    li.children[1].textContent = e.rele;
    li.children[2].textContent = e.estado ? 'ON' : 'OFF';
    li.children[3].textContent = `(${motivoMostrado(e.motivo || '')})`;
    lista.append(li);
  }
}

// ----------------------------------------------------------------- bitácora

async function actualizarBitacora() {
  if (!elegida) return;
  let entradas;
  try { entradas = await api('GET', `/api/salas/${elegida}/bitacora`); } catch { return; }
  const lista = $('#bitacora');
  lista.replaceChildren();
  if (!entradas.length) { lista.innerHTML = '<li>Todavía no hay registros.</li>'; return; }
  for (const e of entradas) {
    const li = document.createElement('li');
    li.innerHTML = '<div><span></span> · <b></b> <span></span></div><button title="Borrar">✕</button>';
    li.querySelector('span').textContent = fechaCorta(e.fecha);
    li.querySelector('b').textContent = e.tipo === 'etapa' ? `→ ${ETAPAS[e.etapa] || e.etapa}` : TIPOS[e.tipo] || e.tipo;
    li.querySelectorAll('span')[1].textContent = e.texto;
    li.querySelector('button').onclick = async () => {
      if (!confirm('¿Borrar esta entrada de la bitácora?')) return;
      await api('DELETE', `/api/salas/${elegida}/bitacora/${e.id}`);
      await actualizarBitacora();
      await actualizar();
    };
    lista.append(li);
  }
}

const formBitacora = $('#form-bitacora');
const mostrarEtapa = () => { formBitacora.querySelector('.campo-etapa').hidden = formBitacora.tipo.value !== 'etapa'; };
formBitacora.tipo.addEventListener('change', mostrarEtapa);
mostrarEtapa();
formBitacora.onsubmit = async ev => {
  ev.preventDefault();
  const f = formBitacora;
  const entrada = { tipo: f.tipo.value, texto: f.texto.value };
  if (entrada.tipo === 'etapa') entrada.etapa = f.etapa.value;
  if (f.fecha.value) entrada.fecha = new Date(f.fecha.value).toISOString();
  try {
    await api('POST', `/api/salas/${elegida}/bitacora`, entrada);
    f.texto.value = '';
    f.fecha.value = '';
    $('#error-bitacora').textContent = '';
    await actualizarBitacora();
    await actualizar();
  } catch (e) {
    $('#error-bitacora').textContent = e.message;
  }
};

// ------------------------------------------------------------------ arranque

function mostrarRango() {
  const conRango = $('#periodo').value === 'rango';
  $('#rango').hidden = !conRango;
  if (conRango && !$('#desde').value) {  // propone la última semana
    const hoy = new Date();
    const fecha = d => d.toLocaleDateString('sv');  // AAAA-MM-DD en hora local
    $('#hasta').value = fecha(hoy);
    $('#desde').value = fecha(new Date(hoy - 6 * 864e5));
  }
}
$('#periodo').addEventListener('change', () => { mostrarRango(); actualizarHistorico(); });
$('#desde').addEventListener('change', actualizarHistorico);
$('#hasta').addEventListener('change', actualizarHistorico);

$('#unidad-dpv').value = unidadDpv;
$('#unidad-dpv').addEventListener('change', () => {
  unidadDpv = $('#unidad-dpv').value;
  try { localStorage.setItem('unidadDpv', unidadDpv); } catch {}
  // Las tarjetas se rearman para que el editor de reglas tome la unidad nueva.
  $('#reles').replaceChildren();
  Object.keys(tarjetas).forEach(k => delete tarjetas[k]);
  if (datos) { pintarPlano(); pintarDetalle(); }
  actualizarHistorico();
});
actualizar().then(() => { actualizarHistorico(); actualizarBitacora(); });
setInterval(actualizar, 5000);
setInterval(actualizarHistorico, 60000);
