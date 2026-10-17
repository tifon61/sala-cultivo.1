// Página del celular. Pide datos a la API del backend (mismo servidor) y los dibuja.
//   GET  /api/estado      -> lecturas actuales + relés     (cada 5 s)
//   GET  /api/historico   -> series para los gráficos     (cada 60 s)
//   POST /api/reles/...   -> control manual / automático

// Nombre y unidad de cada variable que manda el ESP32. Las que no estén acá
// se muestran igual, con su nombre crudo.
const VARIABLES = {
  temperatura:  { nombre: 'Temperatura',   unidad: '°C',  dec: 1 },
  humedad:      { nombre: 'Humedad',       unidad: '%',   dec: 0 },
  dpv:          { nombre: 'DPV',           unidad: 'kPa', dec: 2 },
  co2:          { nombre: 'CO₂',           unidad: 'ppm', dec: 0 },
  temperatura2: { nombre: 'Temp. sensor 2', unidad: '°C', dec: 1 },
  humedad2:     { nombre: 'Hum. sensor 2', unidad: '%',   dec: 0 },
  suelo1:       { nombre: 'Suelo 1',       unidad: '% suelo', dec: 0 },
  suelo2:       { nombre: 'Suelo 2',       unidad: '% suelo', dec: 0 },
  rssi:         { nombre: 'Señal Wi-Fi',   unidad: 'dBm', dec: 0 },
};
const COLORES = ['#10b981', '#38bdf8', '#f59e0b', '#a78bfa', '#f472b6', '#94a3b8'];
const DATO_VIEJO_MS = 3 * 60 * 1000;

const info = v => VARIABLES[v] || { nombre: v, unidad: '', dec: 2 };
const $ = sel => document.querySelector(sel);
let ultimoEstado = null;

async function api(metodo, ruta, cuerpo) {
  const res = await fetch(ruta, {
    method: metodo,
    headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof datos.detail === 'string' ? datos.detail : JSON.stringify(datos.detail));
  return datos;
}

function hora(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ------------------------------------------------------------------ estado

async function actualizarEstado() {
  try {
    ultimoEstado = await api('GET', '/api/estado');
    pintarConexion(ultimoEstado);
    pintarLecturas(ultimoEstado.lecturas);
    pintarReles(ultimoEstado.reles);
  } catch (e) {
    pintarConexion(null);
  }
}

function pintarConexion(estado) {
  const caja = $('#conexion');
  let texto, ok;
  if (!estado) { texto = 'sin conexión al servidor'; ok = false; }
  else if (!estado.mqtt_conectado) { texto = 'servidor sin broker MQTT'; ok = false; }
  else if (!estado.online) { texto = 'ESP32 desconectado'; ok = false; }
  else { texto = estado.ultimo_dato ? `ESP32 · ${hora(estado.ultimo_dato)}` : 'ESP32 conectado'; ok = true; }
  caja.className = 'conexion ' + (ok ? 'ok' : 'mal');
  $('#conexion-texto').textContent = texto;
}

function pintarLecturas(lecturas) {
  const cont = $('#lecturas');
  cont.replaceChildren();
  const vars = Object.keys(lecturas);
  if (!vars.length) {
    cont.innerHTML = '<p class="vacio">Todavía no llegó ninguna medición del ESP32.</p>';
    return;
  }
  for (const v of vars) {
    const { valor, ts } = lecturas[v];
    const i = info(v);
    const tarjeta = document.createElement('div');
    tarjeta.className = 'lectura' + (Date.now() - new Date(ts) > DATO_VIEJO_MS ? ' vieja' : '');
    tarjeta.title = `Última lectura: ${new Date(ts).toLocaleString()}`;
    tarjeta.innerHTML = '<div class="nombre"></div><div><span class="valor"></span><span class="unidad"></span></div>';
    tarjeta.querySelector('.nombre').textContent = i.nombre;
    tarjeta.querySelector('.valor').textContent = valor.toFixed(i.dec);
    tarjeta.querySelector('.unidad').textContent = i.unidad;
    cont.append(tarjeta);
  }
}

// ------------------------------------------------------------------ relés
// Cada tarjeta se crea una sola vez; después solo se actualizan sus textos,
// así no se cierra el formulario de la regla mientras lo estás editando.

const tarjetas = {};

function pintarReles(reles) {
  const cont = $('#reles');
  for (const r of reles) {
    if (!tarjetas[r.id]) {
      tarjetas[r.id] = crearTarjetaRele(r);
      cont.append(tarjetas[r.id]);
    }
    const t = tarjetas[r.id];
    t.querySelector('.rele-nombre').textContent = r.nombre;
    t.querySelector('.rele-motivo').textContent = r.motivo;
    const pastilla = t.querySelector('.pastilla');
    pastilla.textContent = r.encendido == null ? '—' : (r.encendido ? 'ENCENDIDO' : 'APAGADO');
    pastilla.classList.toggle('on', !!r.encendido);
    t.querySelector('.rele-aviso').hidden = r.encendido == null || r.reportado === r.encendido;

    const manual = r.modo === 'manual';
    t.querySelector('[data-accion=auto]').classList.toggle('activo', !manual);
    t.querySelector('[data-accion=on]').classList.toggle('activo', manual && r.manual_estado);
    t.querySelector('[data-accion=off]').classList.toggle('activo', manual && !r.manual_estado);
  }
}

function crearTarjetaRele(rele) {
  const t = $('#tpl-rele').content.firstElementChild.cloneNode(true);
  t.querySelectorAll('[data-accion]').forEach(boton => {
    boton.addEventListener('click', async () => {
      const accion = boton.dataset.accion;
      const minutos = parseInt(t.querySelector('.duracion').value) || null;
      boton.disabled = true;
      try {
        if (accion === 'auto') await api('POST', `/api/reles/${rele.id}/auto`);
        else await api('POST', `/api/reles/${rele.id}/manual`, { encendido: accion === 'on', minutos });
        await actualizarEstado();
      } catch (e) {
        alert('No se pudo cambiar el relé: ' + e.message);
      } finally {
        boton.disabled = false;
      }
    });
  });
  armarFormularioRegla(t.querySelector('.form-regla'), rele.id, rele.regla);
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
  ciclo: [
    ['inicio', 'Primer encendido', 'time'],
    ['cada_min', 'Cada (min)', 'number'],
    ['duracion_min', 'Durante (min)', 'number'],
    ['repeticiones', 'Veces por día (vacío = todo el día)', 'number'],
  ],
};

function armarFormularioRegla(form, rid, regla) {
  form.replaceChildren();
  const tipo = crearCampo(form, 'Tipo', 'select', 'ancho');
  for (const [valor, texto] of [['horario', 'Horario'], ['umbral', 'Umbral (sensor)'], ['ciclo', 'Ciclo']]) {
    tipo.add(new Option(texto, valor, false, valor === regla.tipo));
  }
  tipo.addEventListener('change', () => armarFormularioRegla(form, rid, { tipo: tipo.value }));

  for (const [clave, etiqueta, clase] of CAMPOS[regla.tipo]) {
    let input;
    if (clase === 'variable') {
      input = crearCampo(form, etiqueta, 'select');
      const vars = new Set([...Object.keys(ultimoEstado?.lecturas || {}), regla.variable].filter(Boolean));
      vars.forEach(v => input.add(new Option(info(v).nombre, v)));
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
    const actual = regla[clave];
    if (actual != null) input.value = clase === 'time' ? String(actual).slice(0, 5) : actual;
  }

  const error = document.createElement('p');
  error.className = 'error';
  const guardar = document.createElement('button');
  guardar.type = 'submit';
  guardar.className = 'ancho';
  guardar.textContent = 'Guardar regla';
  form.append(error, guardar);

  form.onsubmit = async ev => {
    ev.preventDefault();
    const nueva = { tipo: tipo.value };
    for (const [clave, , clase] of CAMPOS[tipo.value]) {
      const valor = form.elements[clave].value;
      if (valor === '') continue;
      nueva[clave] = clase === 'number' ? Number(valor) : valor;
    }
    try {
      const r = await api('PUT', `/api/reles/${rid}/regla`, nueva);
      error.textContent = '';
      armarFormularioRegla(form, rid, r.regla);
      form.closest('details').open = false;
      await actualizarEstado();
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

// ------------------------------------------------------------------ gráficos
// Un gráfico por unidad (°C, %, kPa, ppm...), así las escalas tienen sentido.

const graficos = {};

async function actualizarHistorico() {
  const horas = $('#periodo').value;
  let datos;
  try { datos = await api('GET', `/api/historico?horas=${horas}`); } catch { return; }

  const porUnidad = {};
  for (const [variable, puntos] of Object.entries(datos.series)) {
    (porUnidad[info(variable).unidad] ||= []).push([variable, puntos]);
  }

  const cont = $('#graficos');
  for (const unidad of Object.keys(graficos)) {
    if (!porUnidad[unidad]) { graficos[unidad].destroy(); graficos[unidad].canvas.parentElement.remove(); delete graficos[unidad]; }
  }
  if (!Object.keys(porUnidad).length) cont.innerHTML = '<p class="vacio">Sin datos en este período.</p>';
  else cont.querySelector('.vacio')?.remove();

  const conFecha = Number(horas) > 24;
  // Todos los gráficos muestran el período completo, aunque haya pocos datos.
  const ejeX = { min: new Date(datos.desde).getTime(), max: new Date(datos.hasta).getTime() };
  for (const [unidad, series] of Object.entries(porUnidad)) {
    const datasets = series.map(([variable, puntos], i) => ({
      label: info(variable).nombre,
      data: puntos.map(([t, v]) => ({ x: new Date(t).getTime(), y: v })),
      borderColor: COLORES[i % COLORES.length],
      backgroundColor: COLORES[i % COLORES.length],
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
  pintarEventos(datos.eventos);
}

function etiquetaTiempo(conFecha) {
  return valor => {
    const d = new Date(valor);
    return conFecha ? d.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) : hora(d);
  };
}

function pintarEventos(eventos) {
  const lista = $('#eventos');
  lista.replaceChildren();
  if (!eventos.length) { lista.innerHTML = '<li>Sin cambios en este período.</li>'; return; }
  for (const e of eventos.slice(0, 30)) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span> · <b></b> → <b></b> <span></span>';
    const [cuando, rele, estado, motivo] = li.children;
    cuando.textContent = new Date(e.ts).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    rele.textContent = e.rele;
    estado.textContent = e.estado ? 'ON' : 'OFF';
    motivo.textContent = `(${e.motivo})`;
    lista.append(li);
  }
}

// ------------------------------------------------------------------ arranque

$('#periodo').addEventListener('change', actualizarHistorico);
actualizarEstado().then(actualizarHistorico);
setInterval(actualizarEstado, 5000);
setInterval(actualizarHistorico, 60000);
