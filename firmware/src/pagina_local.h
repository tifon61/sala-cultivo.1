// Página de la red de emergencia (http://192.168.4.1).
// Va dentro del firmware como texto. Es una versión reducida de la web del servidor:
// sin gráficos, pero con lecturas, control de relés, reglas, hora y Wi-Fi.
#pragma once

static const char PAGINA_LOCAL[] PROGMEM = R"HTML(<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sala - modo local</title>
<style>
body{margin:0;background:#020617;color:#f1f5f9;font:15px/1.4 system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:16px}
h1{font-size:1.15rem;margin:0 0 4px}h2{font-size:.75rem;letter-spacing:.15em;text-transform:uppercase;color:#94a3b8;margin:22px 0 8px}
.aviso{background:#78350f;border-radius:12px;padding:10px 12px;font-size:.85rem;margin:10px 0}
.chips span{display:inline-block;margin:2px 4px 2px 0;padding:3px 10px;border-radius:99px;background:#1e293b;font-size:.75rem}
.chips .ok{background:#065f46}.chips .mal{background:#7f1d1d}
.grilla{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.card{background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:10px}
.card small{display:block;color:#94a3b8;font-size:.7rem;text-transform:uppercase}.card b{font-size:1.3rem}
.rele{margin-bottom:8px}.fila{display:flex;justify-content:space-between;align-items:center;gap:8px}
.motivo{color:#94a3b8;font-size:.8rem}.on{background:#10b981;color:#020617}
.pill{padding:3px 10px;border-radius:99px;background:#1e293b;font-weight:700;font-size:.75rem}
.botones{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px}
button,select,input{font:inherit;color:#f1f5f9;background:#1e293b;border:1px solid #334155;border-radius:10px;padding:9px 6px;min-height:42px;width:100%;box-sizing:border-box}
button.activo{background:#10b981;color:#020617}
form{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
label{display:grid;gap:3px;font-size:.72rem;color:#94a3b8}.ancho{grid-column:1/-1}
.error{color:#f87171;font-size:.85rem}details summary{color:#94a3b8;font-size:.85rem;margin-top:8px}
</style></head><body><main>
<h1 id="titulo">Sala</h1>
<div class="chips" id="chips"></div>
<div class="aviso">Estás en el <b>modo local</b> del módulo. Lo que cambies acá se aplica ya mismo.
Cuando vuelva la conexión con el servidor, <b>manda la configuración del servidor</b>.</div>
<p class="error" id="error"></p>
<h2>Ahora</h2><div class="grilla" id="lecturas"></div>
<h2>Relés</h2><div id="reles"></div>
<h2>Hora</h2>
<div class="card"><span id="hora"></span><button id="sync" style="margin-top:8px">Usar la hora de este celular</button></div>
<h2>Wi-Fi y servidor</h2>
<form id="red" class="card">
<label class="ancho">Red Wi-Fi<input name="ssid"></label>
<label class="ancho">Clave Wi-Fi (vacío = no cambiar)<input name="clave" type="password"></label>
<label class="ancho">Servidor<input name="mqtt_host"></label>
<label>Puerto<input name="mqtt_puerto" type="number"></label>
<label>TLS<select name="tls"><option value="1">sí</option><option value="0">no</option></select></label>
<label class="ancho">Clave MQTT (vacío = no cambiar)<input name="mqtt_clave" type="password"></label>
<button class="ancho">Guardar y reconectar</button>
</form>
</main>
<script>
const NOMBRES={temperatura:['Temp','°C',1],humedad:['Hum','%',0],dpv:['DPV','kPa',2],co2:['CO₂','ppm',0],temperatura2:['Temp 2','°C',1],humedad2:['Hum 2','%',0]};
const CAMPOS={horario:[['encender','Encender','time'],['apagar','Apagar','time']],
 umbral:[['variable','Variable','text'],['encender_si','Encender si','sel'],['valor','Umbral','number'],['histeresis','Histéresis','number']],
 pulsos:[['encendido_s','Segundos encendido','number'],['cada_min','Cada (min)','number'],['desde','Desde','time'],['hasta','Hasta','time']]};
let estado=null,armado={};
const $=s=>document.querySelector(s);
async function api(ruta,cuerpo){const r=await fetch(ruta,cuerpo?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cuerpo)}:{});
 const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||r.status);return d}
function chip(t,ok){return `<span class="${ok?'ok':'mal'}">${t}</span>`}
async function refrescar(){
 try{estado=await api('/api/estado')}catch(e){$('#error').textContent='Sin respuesta del módulo';return}
 const e=estado;$('#error').textContent=e.error_config?'Config con error: '+e.error_config:'';
 $('#titulo').textContent='Sala '+e.id;
 $('#chips').innerHTML=chip('Wi-Fi',e.wifi)+chip('Servidor',e.servidor)+chip(e.hay_hora?'Hora OK':'Sin hora',e.hay_hora)+(e.pendientes?chip(e.pendientes+' mediciones sin enviar',false):'');
 $('#lecturas').innerHTML=Object.entries(e.lecturas||{}).map(([k,v])=>{const n=NOMBRES[k]||[k,'',1];return `<div class="card"><small>${n[0]}</small><b>${v.toFixed(n[2])}</b> ${n[1]}</div>`}).join('')||'<p class="motivo">Sin lecturas</p>';
 $('#hora').textContent=e.hay_hora?new Date(e.epoch*1000).toLocaleString():'El módulo no sabe la hora: los horarios no funcionan.';
 if(!e.hay_hora&&!refrescar.sincronizado){refrescar.sincronizado=true;sincronizarHora()}
 for(const [id,r] of Object.entries(e.reles)){
  if(!armado[id])armado[id]=armarRele(id);
  const t=armado[id],c=e.config.reles[id]||{};
  t.querySelector('.pill').textContent=r.on?'ENCENDIDO':'APAGADO';t.querySelector('.pill').classList.toggle('on',r.on);
  t.querySelector('.motivo').textContent=r.motivo;
  const manual=c.modo==='manual';
  t.querySelector('[data-a=auto]').classList.toggle('activo',!manual);
  t.querySelector('[data-a=on]').classList.toggle('activo',manual&&c.manual_estado);
  t.querySelector('[data-a=off]').classList.toggle('activo',manual&&!c.manual_estado);
 }
 if(!refrescar.red){refrescar.red=true;const f=$('#red');f.ssid.value=e.red.ssid;f.mqtt_host.value=e.red.mqtt_host;f.mqtt_puerto.value=e.red.mqtt_puerto;f.tls.value=e.red.tls?'1':'0'}
}
async function guardarConfig(cambio){
 const cfg=JSON.parse(JSON.stringify(estado.config));cambio(cfg);
 try{await api('/api/config',cfg);$('#error').textContent=''}catch(e){$('#error').textContent='No se guardó: '+e.message}
 await refrescar();
}
function armarRele(id){
 const d=document.createElement('div');d.className='card rele';
 d.innerHTML=`<div class="fila"><b>${id}</b><span class="pill"></span></div><div class="motivo"></div>
 <div class="botones"><button data-a="auto">Auto</button><button data-a="on">Encender</button><button data-a="off">Apagar</button>
 <select><option value="">sin límite</option><option value="15">15 min</option><option value="60">1 h</option></select></div>
 <details><summary>Regla automática</summary><form></form></details>`;
 d.querySelectorAll('[data-a]').forEach(b=>b.onclick=()=>{const a=b.dataset.a,min=parseInt(d.querySelector('select').value)||0;
  guardarConfig(cfg=>{const r=cfg.reles[id];if(a==='auto'){r.modo='auto'}else{r.modo='manual';r.manual_estado=a==='on';r.manual_hasta=min?Math.floor(Date.now()/1000)+min*60:0}})});
 armarForm(d.querySelector('form'),id,(estado.config.reles[id]||{}).regla||{tipo:'horario'});
 $('#reles').append(d);return d;
}
function armarForm(f,id,regla){
 f.innerHTML='';const tipo=document.createElement('select');
 ['horario','umbral','pulsos'].forEach(t=>tipo.add(new Option(t,t,false,t===regla.tipo)));
 const lt=document.createElement('label');lt.className='ancho';lt.textContent='Tipo';lt.append(tipo);f.append(lt);
 tipo.onchange=()=>armarForm(f,id,{tipo:tipo.value});
 for(const [k,et,cl] of CAMPOS[regla.tipo]){
  const l=document.createElement('label');l.textContent=et;let i;
  if(cl==='sel'){i=document.createElement('select');i.add(new Option('mayor','mayor'));i.add(new Option('menor','menor'))}
  else{i=document.createElement('input');i.type=cl;if(cl==='number')i.step='any'}
  i.name=k;if(regla[k]!=null)i.value=regla[k];l.append(i);f.append(l);
 }
 const b=document.createElement('button');b.className='ancho';b.textContent='Guardar regla';f.append(b);
 f.onsubmit=ev=>{ev.preventDefault();const n={tipo:tipo.value};
  for(const [k,,cl] of CAMPOS[tipo.value]){const v=f.elements[k].value;if(v!=='')n[k]=cl==='number'?Number(v):v}
  guardarConfig(cfg=>{cfg.reles[id]=cfg.reles[id]||{modo:'auto'};cfg.reles[id].regla=n}).then(()=>armarForm(f,id,n))};
}
async function sincronizarHora(){try{await api('/api/hora',{epoch:Math.floor(Date.now()/1000)});await refrescar()}catch(e){}}
$('#sync').onclick=sincronizarHora;
$('#red').onsubmit=async ev=>{ev.preventDefault();const f=ev.target;
 try{await api('/api/red',{ssid:f.ssid.value,clave:f.clave.value,mqtt_host:f.mqtt_host.value,mqtt_puerto:Number(f.mqtt_puerto.value),mqtt_clave:f.mqtt_clave.value,tls:f.tls.value==='1'});alert('Guardado. El módulo intenta reconectarse.')}
 catch(e){alert('Error: '+e.message)}};
refrescar();setInterval(refrescar,3000);
</script></body></html>)HTML";
