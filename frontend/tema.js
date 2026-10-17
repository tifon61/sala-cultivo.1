// Tema de la página: "auto" (sigue al celular), "claro" u "oscuro".
// Se carga en el <head>, antes de dibujar, para que no "parpadee" el tema
// equivocado al abrir. La elección se recuerda en este navegador.
function temaElegido() {
  try { return localStorage.getItem('tema') || 'auto'; } catch { return 'auto'; }
}
function aplicarTema(tema) {
  try { localStorage.setItem('tema', tema); } catch {}
  if (tema === 'auto') document.documentElement.removeAttribute('data-tema');
  else document.documentElement.setAttribute('data-tema', tema);
  // Color de la barra del navegador en el celular
  const oscuro = tema === 'oscuro' || (tema === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', oscuro ? '#0f1115' : '#f3f4f6');
}
aplicarTema(temaElegido());
