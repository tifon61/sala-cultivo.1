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
// Cada sala se arma UNA vez y después solo se le cambian números y clases.
// Si se rearmara entera cada 5 s, las animaciones volverían a empezar.

// Íconos de los equipos (SVG dibujado con el color del texto). Se animan con
// CSS cuando la ficha tiene la clase "on": la lamparita brilla, la gota cae,
// el vapor sube y el ventilador gira. Un relé con otro id lleva un punto.
const ICONOS = {
  luz: '<svg viewBox="0 0 24 24"><circle class="halo" cx="12" cy="10" r="9"/><path d="M8.5 15.5a6 6 0 1 1 7 0V18h-7z"/><path d="M9.5 21h5"/></svg>',
  riego: '<svg viewBox="0 0 24 24"><path class="gota" d="M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11z"/></svg>',
  humidificador: '<svg viewBox="0 0 24 24"><g class="vapor"><path d="M7 14c-2-2 2-4 0-7"/><path d="M12 14c-2-2 2-4 0-7"/><path d="M17 14c-2-2 2-4 0-7"/></g><path d="M5 17h14v4H5z"/></svg>',
  deshumidificador: '<svg viewBox="0 0 24 24"><g class="aspas"><path d="M12 12c0-4 1-7 3-7s2 4-3 7z"/><path d="M12 12c3.5 2 5.5 4.5 4.5 6.2S12.5 18 12 12z"/><path d="M12 12c-3.5 2-6.5 2.3-7.5.6S7 8.5 12 12z"/></g><circle cx="12" cy="12" r="1.3"/></svg>',
};
const iconoDe = rid => ICONOS[rid] || '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>';
// Clase que se le pone a la caja de la sala mientras ese equipo está prendido.
const AMBIENTE = { riego: 'riego-on', humidificador: 'hum-on', deshumidificador: 'deshum-on' };

const cajas = new Map();   // id de sala -> elementos de su caja, para actualizarlos

function pintarPlano() {
  const plano = $('#plano');
  const ids = datos.salas.map(s => s.id).join();
  if (plano.dataset.ids !== ids) {   // la primera vez, o si se agregó/quitó una sala
    cajas.clear();
    plano.replaceChildren(...datos.salas.map((s, i) => armarCaja(s, i)));
    plano.dataset.ids = ids;
  }
  for (const s of datos.salas) actualizarCaja(s, cajas.get(s.id));
}

function armarCaja(s, i) {
  const caja = document.createElement('div');
  caja.className = 'sala-plano';
  caja.style.setProperty('--sala', colorSala(i));
  caja.onclick = () => elegirSala(s.id);
  caja.innerHTML = `
    <div class="ambiente" aria-hidden="true">
      <div class="resplandor"></div>
      <div class="gotas">${'<i></i>'.repeat(9)}</div>
      <div class="niebla">${'<i></i>'.repeat(5)}</div>
    </div>
    <div class="sp-cab"><span class="led"></span><h3></h3></div>
    <div class="sp-etapa"></div>
    <div class="lecturas"></div>
    <div class="equipos"></div>
    <ul class="proximos"></ul>`;
  const c = { caja, lecturas: {}, fichas: {} };
  for (const v of EN_PLANO) {
    const d = document.createElement('div');
    d.className = 'lectura';
    d.innerHTML = '<span class="etiqueta"></span><span class="valor"><span></span><small></small></span>';
    if (v === 'dpv') d.append(armarMedidor());
    caja.querySelector('.lecturas').append(d);
    c.lecturas[v] = d;
  }
  cajas.set(s.id, c);
  return caja;
}

function actualizarCaja(s, c) {
  const { caja } = c;
  caja.classList.toggle('elegida', s.id === elegida);
  const led = caja.querySelector('.sp-cab .led');
  led.className = 'led ' + (s.online ? 'ok' : 'mal');
  led.title = s.online ? 'conectado' : 'desconectado';
  caja.querySelector('h3').textContent = s.nombre;

  const etapa = caja.querySelector('.sp-etapa');
  if (s.etapa) {
    etapa.innerHTML = '<b></b> · <span></span>';
    etapa.children[0].textContent = ETAPAS[s.etapa] || s.etapa;
    etapa.children[1].textContent = `día ${s.dia_etapa} · semana ${Math.ceil(s.dia_etapa / 7)}`;
  } else {
    etapa.textContent = 'sin etapa registrada';
  }

  for (const v of EN_PLANO) {
    const l = s.lecturas[v], d = c.lecturas[v];
    d.classList.toggle('vieja', !l || l.viejo);
    d.querySelector('.etiqueta').textContent = info(v).nombre;
    d.querySelector('.valor span').textContent = l ? mostrar(v, l.valor).toFixed(info(v).dec) : '—';
    d.querySelector('small').textContent = l ? info(v).unidad : '';
  }
  moverMedidor(c.lecturas.dpv, s);

  // Fichas de equipos: también persistentes, para que el ventilador no "salte".
  const equipos = caja.querySelector('.equipos');
  const proximos = [];
  for (const r of s.reles) {
    let e = c.fichas[r.id];
    if (!e) {
      e = c.fichas[r.id] = document.createElement('div');
      e.innerHTML = `<span class="icono">${iconoDe(r.id)}</span><span class="nom"></span>`;
      equipos.append(e);
    }
    e.className = `equipo eq-${r.id}` + (r.on ? ' on' : '');
    e.title = motivoMostrado(r.motivo);
    e.lastChild.textContent = r.nombre + (r.manual_vigente ? ' (manual)' : r.externo ? ' (timer)' : '');
    if (AMBIENTE[r.id]) caja.classList.toggle(AMBIENTE[r.id], !!r.on);
    if (r.proximo) {
      const li = document.createElement('li');
      li.innerHTML = '<span></span><b data-cuando></b>';
      li.children[0].textContent = `${r.nombre}: ${r.proximo.texto}`;
      li.children[1].dataset.cuando = r.proximo.cuando;
      li.children[1].textContent = cuentaRegresiva(r.proximo.cuando);
      proximos.push(li);
    }
  }
  // Luz: prendida = resplandor cálido; apagada = la caja se pone "de noche".
  // Sin dato del módulo no se marca ninguna de las dos.
  const luz = s.reles.find(r => r.id === 'luz');
  caja.classList.toggle('luz-on', luz?.on === true);
  caja.classList.toggle('luz-off', luz?.on === false);
  caja.querySelector('.proximos').replaceChildren(...proximos);
}

// ----------------------------------------------------- medidor de DPV
// Semicírculo de 0,2 a 2,0 kPa. La franja verde es la zona "ideal": entre el
// umbral del deshumidificador (prende si el DPV está por debajo) y el del
// humidificador (prende si está por encima). Los límites salen de las reglas de la
// sala, así que si cambiás un umbral, la franja se mueve sola.
const MEDIDOR = { min: 0.2, max: 2.0, cx: 60, cy: 60, r: 48 };
const fraccion = kpa => Math.min(1, Math.max(0, (kpa - MEDIDOR.min) / (MEDIDOR.max - MEDIDOR.min)));
// Punto del arco: t=0 es la punta izquierda, t=1 la derecha, pasando por arriba.
function puntoArco(t) {
  const { cx, cy, r } = MEDIDOR;
  return [cx - r * Math.cos(t * Math.PI), cy - r * Math.sin(t * Math.PI)].map(n => n.toFixed(2)).join(' ');
}
const arco = (t1, t2) => `M ${puntoArco(t1)} A ${MEDIDOR.r} ${MEDIDOR.r} 0 0 1 ${puntoArco(t2)}`;

function armarMedidor() {
  const div = document.createElement('div');
  div.className = 'medidor';
  div.innerHTML = `<svg viewBox="0 0 120 66" aria-hidden="true">
      <path class="m-fondo" d="${arco(0, 1)}"/>
      <path class="m-zona" d=""/>
      <g class="m-aguja"><path d="M60 60 L60 18"/><circle cx="60" cy="60" r="4"/></g>
    </svg><span class="m-texto"></span>`;
  return div;
}

function zonaDpv(s) {
  const zona = {};
  for (const r of s.reles) {
    const g = r.regla;
    if (g?.tipo !== 'umbral' || g.variable !== 'dpv') continue;
    if (g.encender_si === 'menor') zona.min = g.valor;   // deshumidificador
    if (g.encender_si === 'mayor') zona.max = g.valor;   // humidificador
  }
  return zona;
}

function moverMedidor(tile, s) {
  const m = tile.querySelector('.medidor');
  const l = s.lecturas.dpv;
  const { min, max } = zonaDpv(s);
  const hayZona = min != null && max != null && min < max;
  m.querySelector('.m-zona').setAttribute('d', hayZona ? arco(fraccion(min), fraccion(max)) : '');
  const f = (n, dec = unidadDpv === 'hPa' ? 0 : 1) => mostrar('dpv', n).toFixed(dec).replace('.', ',');
  m.querySelector('.m-texto').textContent = hayZona ? `${f(min)} – ${f(max)}` : '';
  m.title = hayZona ? `Zona ideal: ${f(min, 2)} a ${f(max, 2)} ${unidadDpv}` : 'Sin umbrales de DPV configurados';
  // La aguja gira de -90° (izquierda) a +90° (derecha); CSS anima el giro.
  const aguja = m.querySelector('.m-aguja');
  aguja.style.transform = `rotate(${l ? -90 + fraccion(l.valor) * 180 : -90}deg)`;
  const fuera = l && hayZona && (l.valor < min || l.valor > max);
  tile.classList.toggle('fuera', !!fuera);
  m.classList.toggle('sin-dato', !l);
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
    // Timer externo: sin botones (el módulo no lo maneja) y el estado sale del horario.
    t.classList.toggle('externo', !!r.externo);
    t.querySelector('.rele-regla summary').textContent = r.externo ? 'Horario del timer' : 'Regla automática';
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
  armarFormularioRegla(t.querySelector('.form-regla'), sid, rele.id, rele.regla, rele.externo);
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

function armarFormularioRegla(form, sid, rid, regla, externo = false) {
  form.replaceChildren();
  const tipo = crearCampo(form, 'Tipo', 'select', 'ancho');
  for (const [valor, texto] of [['horario', 'Horario'], ['umbral', 'Umbral (sensor)'], ['pulsos', 'Pulsos de tiempo']]) {
    tipo.add(new Option(texto, valor, false, valor === regla.tipo));
  }
  tipo.addEventListener('change', () => armarFormularioRegla(form, sid, rid, { tipo: tipo.value }, externo));

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
    }, externo);
  }

  // Solo un horario se puede "copiar" de un timer externo.
  let casilla = null;
  if (regla.tipo === 'horario') {
    const label = document.createElement('label');
    label.className = 'casilla ancho';
    casilla = document.createElement('input');
    casilla.type = 'checkbox';
    casilla.checked = externo;
    label.append(casilla, 'Lo maneja un timer externo (el módulo no lo controla; la web muestra el estado según este horario)');
    form.append(label);
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
      const conTimer = !!casilla?.checked;
      const antes = !!sala()?.reles.find(r => r.id === rid)?.externo;
      // El servidor exige horario para el timer externo, así que el orden importa:
      // al sacarlo, primero se saca la marca y después se cambia la regla (que
      // puede dejar de ser horario); al ponerlo, primero la regla y después la marca.
      if (antes && !conTimer) await api('PUT', `/api/salas/${sid}/reles/${rid}/externo`, { externo: false });
      await api('PUT', `/api/salas/${sid}/reles/${rid}/regla`, nueva);
      if (!antes && conTimer) await api('PUT', `/api/salas/${sid}/reles/${rid}/externo`, { externo: true });
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
