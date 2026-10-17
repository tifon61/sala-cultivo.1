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
  temperatura2: { nombre: 'Temp SCD',   unidad: '°C',  dec: 1 },
  humedad2:     { nombre: 'Hum SCD',    unidad: '%',   dec: 1 },
  rssi:         { nombre: 'Wi-Fi',      unidad: 'dBm', dec: 0 },
};
// Variables del esquema, de a pares (izquierda | derecha) para comparar los dos sensores.
const EN_PLANO = ['temperatura', 'temperatura2', 'humedad', 'humedad2', 'dpv', 'co2'];
const ETAPAS = { germinacion: 'Germinación', plantines: 'Plantines', vegetativo: 'Vegetativo', floracion: 'Floración',
                 secado: 'Secado', curado: 'Curado', vacia: 'Vacía' };
const TIPOS = { etapa: 'Etapa', nota: 'Nota', riego_nutrientes: 'Riego con nutrientes', poda: 'Poda',
                trasplante: 'Trasplante', plaga: 'Plaga', cosecha: 'Cosecha', mantenimiento: 'Mantenimiento' };
// Colores: se leen de estilos.css (variables --c-temperatura, --tinta...), así
// hay un solo lugar donde cambiarlos y cada tema (papel / noche) tiene los suyos.
// Los pares que comparten gráfico (DHT vs SCD40) se verificaron para que se
// distingan también con daltonismo; además el SCD40 va con línea punteada.
const css = nombre => getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
const colorDe = variable => css(`--c-${variable}`) || css('--tenue');
const PUNTEADAS = new Set(['temperatura2', 'humedad2']);
// Cada sala tiene su color (--sala-1, --sala-2... en estilos.css), según su orden.
const colorSala = i => `var(--sala-${(i % 4) + 1})`;

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
// Fechas y horas siempre en formato argentino de 24 h (14:30, 17/10), sin importar
// el idioma del navegador. hourCycle 'h23' fuerza 00–23 en vez de AM/PM.
const FORMATO = { locale: 'es-AR', h24: { hourCycle: 'h23' } };
const hora = ts => new Date(ts).toLocaleTimeString(FORMATO.locale, { hour: '2-digit', minute: '2-digit', ...FORMATO.h24 });
const fechaCorta = ts => new Date(ts).toLocaleString(FORMATO.locale,
  { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', ...FORMATO.h24 });
const fechaCompleta = ts => new Date(ts).toLocaleString(FORMATO.locale,
  { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', ...FORMATO.h24 });

let datos = null;          // última respuesta de /api/salas
let elegida = localStorage.getItem('sala') || null;

async function api(metodo, ruta, cuerpo) {
  const res = await fetch(ruta, {
    method: metodo,
    headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  if (res.status === 401) { location.href = '/login.html'; return new Promise(() => {}); }  // sesión vencida
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
  $('#conexion .led').className = 'led ' + (ok ? 'ok' : 'mal');
  $('#conexion-texto').textContent = texto;
}

// ------------------------------------------------------------------ esquema

function pintarPlano() {
  const plano = $('#plano');
  plano.replaceChildren(...datos.salas.map((s, i) => {
    const caja = document.createElement('div');
    caja.className = 'sala-plano' + (s.id === elegida ? ' elegida' : '');
    caja.style.setProperty('--sala', colorSala(i));
    caja.onclick = () => elegirSala(s.id);

    const cab = document.createElement('div');
    cab.className = 'sp-cab';
    cab.innerHTML = `<span class="led ${s.online ? 'ok' : 'mal'}" title="${s.online ? 'conectado' : 'desconectado'}"></span><h3></h3>`;
    cab.querySelector('h3').textContent = s.nombre;

    const etapa = document.createElement('div');
    etapa.className = 'sp-etapa';
    if (s.etapa) {
      etapa.innerHTML = '<b></b> · <span></span>';
      etapa.children[0].textContent = ETAPAS[s.etapa] || s.etapa;
      etapa.children[1].textContent = `día ${s.dia_etapa} · semana ${Math.ceil(s.dia_etapa / 7)}`;
    } else {
      etapa.textContent = 'sin etapa registrada';
    }

    const lecturas = document.createElement('div');
    lecturas.className = 'lecturas';
    for (const v of EN_PLANO) {
      const l = s.lecturas[v];
      const d = document.createElement('div');
      d.className = 'lectura' + (!l || l.viejo ? ' vieja' : '');
      d.innerHTML = '<span class="etiqueta"></span><span class="valor"><span></span><small></small></span>';
      d.querySelector('.etiqueta').textContent = info(v).nombre;
      d.querySelector('.valor span').textContent = l ? mostrar(v, l.valor).toFixed(info(v).dec) : '—';
      d.querySelector('small').textContent = l ? info(v).unidad : '';
      lecturas.append(d);
    }

    const equipos = document.createElement('div');
    equipos.className = 'equipos';
    const proximos = document.createElement('ul');
    proximos.className = 'proximos';
    for (const r of s.reles) {
      const e = document.createElement('div');
      e.className = 'equipo' + (r.on ? ' on' : '');
      e.title = motivoMostrado(r.motivo);
      e.innerHTML = '<span class="led"></span><span class="nom"></span>';
      e.firstChild.classList.toggle('on', !!r.on);
      e.lastChild.textContent = r.nombre + (r.manual_vigente ? ' (manual)' : '');
      equipos.append(e);
      if (r.proximo) {
        const li = document.createElement('li');
        li.innerHTML = '<span></span><b data-cuando></b>';
        li.children[0].textContent = `${r.nombre}: ${r.proximo.texto}`;
        li.children[1].dataset.cuando = r.proximo.cuando;
        li.children[1].textContent = cuentaRegresiva(r.proximo.cuando);
        proximos.append(li);
      }
    }
    caja.append(cab, etapa, lecturas, equipos, proximos);
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
    b.style.setProperty('--sala', colorSala(datos.salas.indexOf(s)));
    b.className = s.id === elegida ? 'activo' : '';
    b.onclick = () => elegirSala(s.id);
    return b;
  }));
}

function pintarDetalle() {
  const s = sala();
  if (!s) return;
  // El color de la sala elegida tiñe los botones y fichas de la parte de abajo.
  document.documentElement.style.setProperty('--sala', colorSala(datos.salas.indexOf(s)));
  const m = s.modulo;
  const partes = [s.online ? `Módulo conectado · último dato ${s.ultimo_dato ? hora(s.ultimo_dato) : '—'}` : 'Módulo DESCONECTADO (sigue funcionando solo con su última configuración)'];
  if (m.version_aplicada != null && m.version_aplicada !== m.version_servidor) partes.push('<span class="alerta">configuración pendiente de llegar al módulo</span>');
  if (m.config_local) partes.push('<span class="alerta">cambiada desde la red local del módulo</span>');
  if (m.modo_ap) partes.push('<span class="alerta">red de emergencia activa</span>');
  if (m.hay_hora === false) partes.push('<span class="alerta">el módulo no tiene hora</span>');
  if (m.pendientes) partes.push(`${m.pendientes} mediciones guardadas por enviar`);
  if (m.error) partes.push(`<span class="alerta">error: ${m.error.replace(/</g, '&lt;')}</span>`);
  $('#modulo').innerHTML = partes.join(' · ');
  if ($('#form-nombre').nombre.hidden) $('#form-nombre').nombre.value = s.nombre;
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
    t.querySelector('.rele-nombre').textContent = r.nombre;
    t.querySelector('.rele-motivo').textContent = motivoMostrado(r.motivo);
    t.querySelector('.led').classList.toggle('on', !!r.on);
    const estado = t.querySelector('.estado');
    estado.textContent = r.on == null ? 'sin datos' : (r.on ? 'encendido' : 'apagado');
    estado.classList.toggle('on', !!r.on);
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
      if (clase === 'time') {
        // Texto "HH:MM" en vez de <input type=time>: ese control muestra AM/PM
        // según el idioma del navegador.
        Object.assign(input, { type: 'text', inputMode: 'numeric', maxLength: 5, placeholder: 'HH:MM',
          pattern: '([01][0-9]|2[0-3]):[0-5][0-9]', title: 'Hora en formato 24 h, por ejemplo 14:30' });
      } else {
        input.type = clase;
        if (clase === 'number') input.step = 'any';
      }
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
      borderColor: colorDe(variable),
      backgroundColor: colorDe(variable),
      borderDash: PUNTEADAS.has(variable) ? [6, 4] : [],
      borderWidth: 1.75, pointRadius: 0, tension: 0.2,
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
          x: { type: 'linear', ...ejeX, border: { color: css('--linea-fuerte') },
               afterBuildTicks: escala => { escala.ticks = marcasTiempo(escala.min, escala.max); },
               ticks: { color: css('--tenue'), maxTicksLimit: 6, callback: etiquetaTiempo(conFecha) },
               grid: { color: css('--linea'), tickLength: 4 } },
          y: { border: { color: css('--linea-fuerte') },
               title: { display: true, text: unidad, color: css('--tenue') },
               ticks: { color: css('--tenue') }, grid: { color: css('--linea') } },
        },
        plugins: {
          legend: { align: 'start', labels: { color: css('--tinta'), boxWidth: 14, boxHeight: 2, useBorderRadius: false } },
          tooltip: { callbacks: { title: items => fechaCompleta(items[0].parsed.x) } },
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

// Marcas del eje de tiempo en horas o días "redondos" de la hora local
// (00:00, 04:00, 08:00… o un día a la medianoche), según el largo del período.
function marcasTiempo(min, max) {
  const horas = (max - min) / 36e5;
  const marcas = [];
  if (horas <= 36) {
    const paso = horas <= 8 ? 1 : horas <= 16 ? 2 : horas <= 24 ? 4 : 6;
    const t = new Date(min);
    t.setMinutes(0, 0, 0);
    while (t.getHours() % paso) t.setHours(t.getHours() + 1);
    for (; t <= max; t.setHours(t.getHours() + paso)) if (t >= min) marcas.push({ value: t.getTime() });
  } else {
    const dias = horas / 24;
    const paso = Math.max(1, Math.ceil(dias / 6));
    const t = new Date(min);
    t.setHours(0, 0, 0, 0);
    for (; t <= max; t.setDate(t.getDate() + paso)) if (t >= min) marcas.push({ value: t.getTime() });
  }
  return marcas;
}

function etiquetaTiempo(conFecha) {
  return valor => conFecha ? new Date(valor).toLocaleDateString(FORMATO.locale, { day: '2-digit', month: '2-digit' }) : hora(valor);
}

function pintarEventos(eventos) {
  const lista = $('#eventos');
  lista.replaceChildren();
  if (!eventos.length) { lista.innerHTML = '<li class="vacio-li">Sin cambios en este período.</li>'; return; }
  for (const e of eventos.slice(0, 30)) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span><b></b> <span></span> <span></span></span><span></span>';
    li.children[0].textContent = fechaCorta(e.ts);
    li.querySelector('b').textContent = e.rele;
    const estado = li.children[1].children[1];
    estado.textContent = e.estado ? 'ON' : 'OFF';
    estado.className = e.estado ? 'on' : '';
    li.children[1].children[2].textContent = `— ${motivoMostrado(e.motivo || '')}`;
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
  if (!entradas.length) { lista.innerHTML = '<li class="vacio-li">Todavía no hay registros.</li>'; return; }
  for (const e of entradas) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span><b></b> <span></span></span><button title="Borrar">✕</button>';
    li.children[0].textContent = fechaCorta(e.fecha);
    li.querySelector('b').textContent = e.tipo === 'etapa' ? `→ ${ETAPAS[e.etapa] || e.etapa}` : TIPOS[e.tipo] || e.tipo;
    li.children[1].lastChild.textContent = e.texto;
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
  if (f.fecha.value) entrada.fecha = new Date(`${f.fecha.value}T${f.hora.value || '12:00'}`).toISOString();
  try {
    await api('POST', `/api/salas/${elegida}/bitacora`, entrada);
    f.texto.value = '';
    f.fecha.value = '';
    f.hora.value = '';
    $('#error-bitacora').textContent = '';
    await actualizarBitacora();
    await actualizar();
  } catch (e) {
    $('#error-bitacora').textContent = e.message;
  }
};

// ------------------------------------------------------------------ arranque

// Renombrar la sala elegida: el botón muestra el campo; Enter o el botón guardan.
const formNombre = $('#form-nombre');
$('#btn-renombrar').addEventListener('click', async () => {
  const campo = formNombre.nombre;
  if (campo.hidden) {
    campo.hidden = false;
    $('#btn-renombrar').textContent = 'Guardar';
    campo.focus();
    campo.select();
    return;
  }
  try {
    await api('PUT', `/api/salas/${elegida}/nombre`, { nombre: campo.value.trim() });
    campo.hidden = true;
    $('#btn-renombrar').textContent = 'Renombrar';
    await actualizar();
  } catch (e) {
    alert('No se pudo renombrar: ' + e.message);
  }
});
formNombre.addEventListener('submit', ev => { ev.preventDefault(); $('#btn-renombrar').click(); });

// Cuando cambia el tema (botón o configuración del celular) se rearman los
// gráficos, que leen sus colores de estilos.css al crearse.
function rearmarGraficos() {
  for (const u of Object.keys(graficos)) {
    const caja = graficos[u].canvas.parentElement;
    graficos[u].destroy();
    caja.remove();
    delete graficos[u];
  }
  actualizarHistorico();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rearmarGraficos);

// Botón de tema: Auto -> Claro -> Oscuro -> Auto (la elección vive en tema.js).
const NOMBRES_TEMA = { auto: 'Auto', claro: 'Claro', oscuro: 'Oscuro' };
$('#tema').textContent = NOMBRES_TEMA[temaElegido()];
$('#tema').addEventListener('click', () => {
  const siguiente = { auto: 'claro', claro: 'oscuro', oscuro: 'auto' }[temaElegido()];
  aplicarTema(siguiente);
  $('#tema').textContent = NOMBRES_TEMA[siguiente];
  rearmarGraficos();
});

$('#salir').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

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
