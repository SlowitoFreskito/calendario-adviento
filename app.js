(() => {
  "use strict";

  // ---------- Configuración ----------
  const ANIO = 2026;
  const MES = 11; // diciembre (los meses empiezan en 0)
  const TOTAL_DIAS = 28;
  const CARPETA = "recompensas/";
  const DIA_MS = 86400000;

  // Modos especiales (se activan añadiendo algo a la dirección):
  //   ?modo=prueba  -> simulador: reloj falso que puedes adelantar, con su propio guardado.
  //                    No toca el progreso real.
  //   ?modo=abierto -> todas las cajas abiertas, para revisar las sorpresas.
  const MODO = new URLSearchParams(location.search).get("modo");
  const MODO_PRUEBA = MODO === "prueba";
  const MODO_ABIERTO = MODO === "abierto";
  const CLAVE_GUARDADO = (MODO_PRUEBA ? "cajas-prueba-" : "cajas-estado-") + ANIO;
  const CLAVE_DESFASE = "cajas-prueba-desfase-" + ANIO;

  // Reloj: en modo prueba se le suma un desfase para "viajar en el tiempo".
  let desfase = 0;
  if (MODO_PRUEBA) {
    desfase = Number(localStorage.getItem(CLAVE_DESFASE)) || 0;
  }
  const ahora = () => Date.now() + desfase;

  // ---------- Regalos cifrados ----------
  // Los regalos están cifrados (AES-GCM) con una llave que sale de la contraseña.
  // Sin la contraseña, ni los archivos ni sus títulos se pueden leer.
  const CIFRADO = window.RECOMPENSAS_CIFRADAS || null;
  const CLAVE_LLAVE = "llave-" + ANIO;
  let llave = null; // CryptoKey AES-GCM, disponible tras entrar

  const deB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const aB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

  async function derivarLlave(clave) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(clave), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: deB64(CIFRADO.sal), iterations: CIFRADO.iteraciones, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
  }

  const descifrar = (iv, datos, k = llave) =>
    crypto.subtle.decrypt({ name: "AES-GCM", iv: typeof iv === "string" ? deB64(iv) : iv }, k,
      typeof datos === "string" ? deB64(datos) : datos);

  // Comprueba una llave intentando descifrar el verificador.
  async function llaveValida(k) {
    try {
      const t = new TextDecoder().decode(await descifrar(CIFRADO.verificador.iv, CIFRADO.verificador.datos, k));
      return t === "calendario-ok";
    } catch { return false; }
  }

  async function datosRecompensa(dia) {
    const r = CIFRADO && CIFRADO.regalos[dia];
    if (!r || !llave) return null;
    const meta = JSON.parse(new TextDecoder().decode(await descifrar(r.meta.iv, r.meta.datos)));
    return { ...meta, archivo: r.archivo, iv: r.iv };
  }

  async function descargarRegalo(datos) {
    const resp = await fetch(CARPETA + datos.archivo, { cache: "no-cache" });
    if (!resp.ok) throw new Error("No se encuentra el archivo");
    const claro = await descifrar(datos.iv, await resp.arrayBuffer());
    return new Blob([claro], { type: datos.tipo });
  }

  const CORAZON = `<svg viewBox="0 0 100 92" aria-hidden="true"><path d="M50 86 C22 66 6 50 6 31 C6 17 16 7 29 7 C39 7 46 13 50 21 C54 13 61 7 71 7 C84 7 94 17 94 31 C94 50 78 66 50 86 Z"/></svg>`;
  const CANDADO = `<svg class="caja-candado" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2.5" fill="currentColor"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>`;

  // ---------- Utilidades ----------
  const $ = (sel) => document.querySelector(sel);
  const INICIO = new Date(ANIO, MES, 1); // la caja 1 se abre el 1 de diciembre a las 00:00
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const reducirMovimiento = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Guardamos cuándo se abrió cada caja y cuándo se desbloqueó:
  // { aperturas: { "1": 1764590160000, ... }, desbloqueos: { "2": ..., ... } }
  const leerEstado = () => {
    try {
      const e = JSON.parse(localStorage.getItem(CLAVE_GUARDADO)) || {};
      return { aperturas: e.aperturas || {}, desbloqueos: e.desbloqueos || {} };
    } catch { return { aperturas: {}, desbloqueos: {} }; }
  };
  const estado = MODO_ABIERTO ? { aperturas: {}, desbloqueos: {} } : leerEstado();
  const { aperturas, desbloqueos } = estado;
  const abiertas = { has: (dia) => aperturas[dia] != null };
  const guardar = () => {
    if (MODO_ABIERTO) return;
    try { localStorage.setItem(CLAVE_GUARDADO, JSON.stringify(estado)); } catch { /* sin almacenamiento */ }
  };
  const guardarApertura = (dia) => { aperturas[dia] = ahora(); guardar(); };

  // Cuándo se desbloquea cada caja:
  // - la 1, el 1 de diciembre a las 00:00;
  // - las demás, 24 horas después de abrir la anterior;
  // - si la anterior no se abre, igualmente 24 horas después de que se desbloqueara,
  //   así los regalos se van acumulando y nunca se pierde ninguno.
  // Una caja ya desbloqueada se queda desbloqueada para siempre.
  const desbloqueoDe = (dia) => {
    if (dia === 1) return INICIO.getTime();
    if (desbloqueos[dia] != null) return desbloqueos[dia];
    const base = aperturas[dia - 1] ?? desbloqueoDe(dia - 1);
    const momento = base + DIA_MS;
    if (momento <= ahora()) { desbloqueos[dia] = momento; guardar(); }
    return momento;
  };
  const estaDisponible = (dia) => MODO_ABIERTO || abiertas.has(dia) || ahora() >= desbloqueoDe(dia);

  // La primera caja que todavía no se ha desbloqueado (o null si ya lo están todas).
  const siguienteBloqueada = () => {
    for (let dia = 1; dia <= TOTAL_DIAS; dia++) if (!estaDisponible(dia)) return dia;
    return null;
  };

  // Regalos desbloqueados que todavía no se han abierto.
  const pendientes = () => {
    let n = 0;
    for (let dia = 1; dia <= TOTAL_DIAS; dia++) if (estaDisponible(dia) && !abiertas.has(dia)) n++;
    return n;
  };

  const formatoEspera = (ms) => {
    const min = Math.ceil(ms / 60000);
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h === 0) return `${m} min`;
    return m ? `${h} h y ${m} min` : `${h} h`;
  };

  const formatoHora = (fecha) =>
    fecha.toLocaleString("es-ES", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });


  // Mezcla siempre igual, para que las cajas salgan desordenadas como en un calendario de verdad.
  const mezclar = (lista, semilla) => {
    const a = lista.slice();
    let s = semilla;
    const azar = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(azar() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // ---------- Cajas ----------
  const contenedor = $("#cajas");
  const orden = [...mezclar([...Array(TOTAL_DIAS - 1)].map((_, i) => i + 1), 1828), TOTAL_DIAS];
  const cajas = [];

  orden.forEach((dia) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "caja" + (dia === TOTAL_DIAS ? " final" : "");
    b.dataset.dia = dia;
    b.innerHTML = `
      <span class="caja-sorpresa">${CORAZON}</span>
      <span class="caja-cuerpo"></span>
      <span class="caja-tapa"><span class="caja-lazo"></span></span>
      <span class="caja-etiqueta">${dia}</span>
      ${CANDADO}`;
    b.addEventListener("click", () => abrirCaja(b));
    contenedor.appendChild(b);
    cajas.push(b);
  });

  function actualizarCaja(b) {
    const dia = Number(b.dataset.dia);
    const disponible = estaDisponible(dia);
    const abierta = abiertas.has(dia);
    b.classList.toggle("bloqueada", !disponible);
    b.classList.toggle("disponible", disponible && !abierta);
    b.classList.toggle("abierta", abierta);
    // "hoy" = la caja que toca abrir ahora mismo (da saltitos)
    b.classList.toggle("hoy", disponible && !abierta);
    b.querySelector(".caja-candado").style.display = disponible ? "none" : "";
    b.setAttribute("aria-label",
      `Caja ${dia}` + (!disponible ? ", todavía cerrada" : abierta ? ", ya abierta" : ", lista para abrir"));
  }

  const actualizarTodo = () => { cajas.forEach(actualizarCaja); actualizarCuenta(); };

  // ---------- Abrir ----------
  let ocupado = false;

  async function abrirCaja(b) {
    if (ocupado) return;
    const dia = Number(b.dataset.dia);

    if (!estaDisponible(dia)) {
      reiniciarAnimacion(b, "sacudir");
      if (dia === siguienteBloqueada()) {
        avisar(`La caja ${dia} se abre en ${formatoEspera(desbloqueoDe(dia) - ahora())}.`);
      } else {
        avisar(`La caja ${dia} todavía no se ha desbloqueado.`);
      }
      return;
    }

    if (abiertas.has(dia)) {
      mostrarRecompensa(dia);
      return;
    }

    // Primera vez: la caja tiembla, la tapa salta y sale un corazón.
    ocupado = true;
    guardarApertura(dia);

    if (!reducirMovimiento) {
      b.classList.remove("hoy");
      reiniciarAnimacion(b, "sacudir");
      await esperar(450);
    }
    b.classList.add("destapando");
    actualizarTodo();
    setTimeout(() => b.classList.remove("destapando"), 950);
    if (!reducirMovimiento) {
      lanzarChispas(b, dia === TOTAL_DIAS ? 22 : 12);
      await esperar(900);
    }
    ocupado = false;
    mostrarRecompensa(dia);
  }

  function reiniciarAnimacion(el, clase, duracion = 500) {
    el.classList.remove(clase);
    void el.offsetWidth;
    el.classList.add(clase);
    setTimeout(() => el.classList.remove(clase), duracion);
  }

  function lanzarChispas(b, cantidad) {
    const colores = ["#fff4e2", "#e8463a", "#f2c14e", "#f6aebb"];
    for (let i = 0; i < cantidad; i++) {
      const c = document.createElement("span");
      c.className = "chispa";
      const ang = -Math.PI / 2 + (Math.random() - .5) * Math.PI * 1.3;
      const dist = 35 + Math.random() * 45;
      c.style.setProperty("--dx", Math.cos(ang) * dist + "px");
      c.style.setProperty("--dy", Math.sin(ang) * dist + "px");
      c.style.background = colores[i % colores.length];
      c.style.animationDelay = Math.random() * 120 + "ms";
      b.appendChild(c);
      setTimeout(() => c.remove(), 1100);
    }
  }

  // ---------- Visor ----------
  const modal = $("#modal");
  const modalContenido = $("#modalContenido");
  let ultimoFoco = null;

  let urlActual = null;   // URL temporal del regalo descifrado (se libera al cerrar)
  let peticion = 0;       // evita mezclar regalos si se abren dos seguidos

  async function mostrarRecompensa(dia) {
    ultimoFoco = document.activeElement;
    const esFinal = dia === TOTAL_DIAS;
    const mia = ++peticion;

    const abiertaEl = aperturas[dia] ? `, abierta el ${formatoHora(new Date(aperturas[dia]))}` : "";
    $("#modalFecha").textContent = `Caja ${dia} de ${TOTAL_DIAS}${abiertaEl}`;
    $("#modalTitulo").textContent = esFinal ? "Año y medio juntos" : "Tu regalo";
    modalContenido.innerHTML = `<p class="mensaje pendiente">Abriendo tu regalo…</p>`;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    modal.querySelector(".modal-cerrar").focus();

    let datos = null;
    try { datos = await datosRecompensa(dia); } catch { datos = null; }
    if (mia !== peticion) return;

    datos = datos || {};
    if (datos.titulo) $("#modalTitulo").textContent = datos.titulo;
    modalContenido.innerHTML = "";

    if (datos.mensaje) {
      const p = document.createElement("p");
      p.className = "mensaje";
      p.textContent = datos.mensaje;
      modalContenido.appendChild(p);
    }

    if (datos.archivo) {
      const hueco = document.createElement("p");
      hueco.className = "mensaje pendiente";
      hueco.textContent = "Abriendo tu regalo…";
      modalContenido.appendChild(hueco);
      try {
        const blob = await descargarRegalo(datos);
        if (mia !== peticion) return;
        urlActual = URL.createObjectURL(blob);
        hueco.replaceWith(await crearVisor(datos, blob, urlActual));
      } catch {
        if (mia !== peticion) return;
        hueco.textContent = "No se ha podido abrir este regalo. Comprueba la conexión y vuelve a intentarlo.";
      }
    } else if (!datos.mensaje) {
      modalContenido.insertAdjacentHTML("beforeend",
        `<p class="mensaje pendiente">La sorpresa de esta caja todavía no está aquí.</p>`);
    }
  }

  async function crearVisor(datos, blob, url) {
    const tipo = datos.tipo || "";
    let el;

    if (tipo.startsWith("image/")) {
      el = document.createElement("img");
      el.src = url;
      el.alt = "La sorpresa de hoy";
    } else if (tipo.startsWith("video/")) {
      el = document.createElement("video");
      el.src = url;
      el.controls = true;
      el.playsInline = true;
      el.autoplay = true;
    } else if (tipo.startsWith("audio/")) {
      el = document.createElement("audio");
      el.src = url;
      el.controls = true;
      el.autoplay = true;
    } else if (tipo.startsWith("text/plain")) {
      el = document.createElement("div");
      el.className = "texto";
      el.textContent = await blob.text();
    } else if (tipo === "application/pdf" || tipo.startsWith("text/html")) {
      // Algunos móviles no muestran PDF incrustados: dejamos también el botón para abrirlo
      el = document.createElement("div");
      const marco = document.createElement("iframe");
      marco.src = url;
      marco.title = "La sorpresa de hoy";
      el.append(marco, enlaceArchivo(url, datos.nombre));
    } else {
      el = enlaceArchivo(url, datos.nombre);
    }
    return el;
  }

  function enlaceArchivo(url, nombre) {
    const a = document.createElement("a");
    a.className = "boton";
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    if (nombre) a.download = nombre;
    a.textContent = "Abrir la sorpresa";
    return a;
  }

  function cerrarModal() {
    peticion++;
    modal.hidden = true;
    document.body.style.overflow = "";
    modalContenido.querySelectorAll("video, audio").forEach((m) => m.pause());
    modalContenido.innerHTML = "";
    if (urlActual) { URL.revokeObjectURL(urlActual); urlActual = null; }
    if (ultimoFoco) ultimoFoco.focus();
  }

  modal.addEventListener("click", (e) => { if (e.target.closest("[data-cerrar]")) cerrarModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) cerrarModal(); });

  // ---------- Aviso ----------
  const aviso = $("#aviso");
  let temporizador;
  function avisar(texto) {
    aviso.textContent = texto;
    aviso.classList.add("visible");
    clearTimeout(temporizador);
    temporizador = setTimeout(() => aviso.classList.remove("visible"), 2800);
  }

  // ---------- Cuenta atrás ----------
  // Antes del 1 de diciembre cuenta hasta la primera caja. Después, cuenta
  // hasta la siguiente: 24 horas desde que se abrió la anterior.
  const cuenta = $("#cuenta");
  const cuentaTitulo = $("#cuentaTitulo");
  const pista = $("#pista");
  let estadoAnterior = "";

  function pintarReloj(ms) {
    let resto = Math.max(0, ms);
    const d = Math.floor(resto / DIA_MS); resto -= d * DIA_MS;
    const h = Math.floor(resto / 3600000); resto -= h * 3600000;
    const m = Math.floor(resto / 60000); resto -= m * 60000;
    $("#cDias").textContent = d;
    $("#cHoras").textContent = String(h).padStart(2, "0");
    $("#cMin").textContent = String(m).padStart(2, "0");
    $("#cSeg").textContent = String(Math.floor(resto / 1000)).padStart(2, "0");
  }

  const disponibles = $("#disponibles");
  const disponiblesNumero = $("#disponiblesNumero");
  const disponiblesTexto = $("#disponiblesTexto");

  // Al pulsar el contador, lleva a la primera caja sin abrir.
  disponibles.addEventListener("click", () => {
    const caja = contenedor.querySelector(".caja.disponible");
    if (!caja) {
      avisar("No tienes regalos sin abrir ahora mismo.");
      return;
    }
    caja.scrollIntoView({ behavior: reducirMovimiento ? "auto" : "smooth", block: "center" });
    caja.focus({ preventScroll: true });
    setTimeout(() => reiniciarAnimacion(caja, "sacudir", 500), 400);
  });

  function actualizarCuenta() {
    const proxima = siguienteBloqueada();
    const porAbrir = pendientes();
    let clave;

    // Regalos acumulados sin abrir
    disponibles.hidden = MODO_ABIERTO;
    if (disponiblesNumero.textContent !== String(porAbrir)) {
      if (porAbrir > Number(disponiblesNumero.textContent)) reiniciarAnimacion(disponibles, "salto", 650);
      disponiblesNumero.textContent = porAbrir;
    }
    disponibles.classList.toggle("hay", porAbrir > 0);
    disponiblesTexto.textContent = "sin abrir";
    disponibles.setAttribute("aria-label",
      porAbrir === 0 ? "No tienes regalos sin abrir" : porAbrir === 1 ? "Tienes 1 regalo sin abrir" : `Tienes ${porAbrir} regalos sin abrir`);

    if (MODO_ABIERTO) {
      clave = "abierto";
      cuenta.hidden = true;
      cuentaTitulo.textContent = "Todas las cajas abiertas";
      pista.textContent = "Modo para revisar las sorpresas. No se guarda nada.";
    } else if (proxima === null) {
      // Ya están todas desbloqueadas
      clave = "todas-" + porAbrir;
      cuenta.hidden = true;
      if (porAbrir === 0) {
        cuentaTitulo.textContent = "Has abierto las 28 cajas";
        pista.textContent = "Feliz año y medio, mi amor.";
      } else {
        cuentaTitulo.textContent = "Ya no quedan cajas por desbloquear";
        pista.textContent = "Abre las que te quedan cuando quieras.";
      }
    } else {
      const momento = desbloqueoDe(proxima);
      clave = "espera-" + proxima;
      cuenta.hidden = false;
      pintarReloj(momento - ahora());
      if (proxima === 1) {
        cuentaTitulo.textContent = "La primera caja se abre en";
        pista.textContent = "El 1 de diciembre a las 00:00.";
      } else {
        cuentaTitulo.textContent = proxima === TOTAL_DIAS ? "La última caja se abre en" : "El siguiente regalo se abre en";
        pista.textContent = abiertas.has(proxima - 1)
          ? `La caja ${proxima}, el ${formatoHora(new Date(momento))}: 24 horas después de abrir la ${proxima - 1}.`
          : `La caja ${proxima}, el ${formatoHora(new Date(momento))}.`;
      }
    }

    // Cuando el reloj llega a cero, se desbloquea la caja sin recargar la página.
    clave += "-" + porAbrir;
    if (clave !== estadoAnterior) {
      estadoAnterior = clave;
      cajas.forEach(actualizarCaja);
    }
  }

  // ---------- Panel del modo prueba ----------
  function montarPanelPrueba() {
    const panel = document.createElement("aside");
    panel.className = "panel-prueba";
    panel.setAttribute("aria-label", "Controles del modo prueba");
    panel.innerHTML = `
      <button type="button" class="panel-titulo" data-plegar aria-expanded="true">Modo prueba <span>ocultar</span></button>
      <p class="panel-reloj" id="panelReloj"></p>
      <div class="panel-botones">
        <button type="button" data-salto="3600000">+1 hora</button>
        <button type="button" data-salto="21600000">+6 horas</button>
        <button type="button" data-salto="86400000">+1 día</button>
        <button type="button" data-ir="1">Ir al 1 dic</button>
        <button type="button" data-ir="28">Ir al 28 dic</button>
        <button type="button" data-reiniciar class="panel-reiniciar">Empezar de cero</button>
      </div>
      <p class="panel-nota">Este modo tiene su propio guardado y no toca el progreso real.</p>`;
    document.body.appendChild(panel);

    const reloj = panel.querySelector("#panelReloj");
    const pintar = () => {
      reloj.textContent = new Date(ahora()).toLocaleString("es-ES",
        { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    };
    const fijarDesfase = (nuevo) => {
      desfase = Math.max(0, nuevo); // solo hacia delante, nunca antes de hoy
      localStorage.setItem(CLAVE_DESFASE, String(desfase));
      estadoAnterior = "";
      actualizarCuenta();
      pintar();
    };

    panel.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.hasAttribute("data-plegar")) {
        const plegado = panel.classList.toggle("plegado");
        b.setAttribute("aria-expanded", String(!plegado));
        b.querySelector("span").textContent = plegado ? "mostrar" : "ocultar";
      } else if (b.dataset.salto) {
        fijarDesfase(desfase + Number(b.dataset.salto));
      } else if (b.dataset.ir) {
        const destino = new Date(ANIO, MES, Number(b.dataset.ir), 0, 0, 0).getTime();
        if (destino <= ahora()) { avisar("Ya has pasado esa fecha. Usa «Empezar de cero»."); return; }
        fijarDesfase(destino - Date.now());
      } else if (b.hasAttribute("data-reiniciar")) {
        localStorage.removeItem(CLAVE_GUARDADO);
        localStorage.removeItem(CLAVE_DESFASE);
        localStorage.removeItem("carta-leida-prueba-" + ANIO);
        location.reload();
      }
    });

    pintar();
    setInterval(pintar, 1000);
  }

  // ---------- Buzón y carta de bienvenida ----------
  const CLAVE_CARTA = "carta-leida-" + (MODO_PRUEBA ? "prueba-" : "") + ANIO;
  const buzon = $("#buzon");
  const buzonTexto = $("#buzonTexto");
  const cartaModal = $("#cartaModal");
  const cartaEscena = $("#cartaEscena");
  let cartaAbierta = false;

  function pintarBuzon() {
    let leida = false;
    try { leida = localStorage.getItem(CLAVE_CARTA) === "1"; } catch { /* sin almacenamiento */ }
    buzon.classList.toggle("sin-leer", !leida);
    buzon.classList.toggle("leida", leida);
    buzonTexto.textContent = leida ? "Volver a leer la carta" : "Tienes una carta";
    buzon.setAttribute("aria-label", leida ? "Volver a leer la carta de bienvenida" : "Tienes una carta. Ábrela");
  }

  async function abrirCarta() {
    if (cartaAbierta) return;
    cartaAbierta = true;
    ultimoFoco = document.activeElement;

    // El sobre sale volando del buzón
    buzon.classList.add("sacando");
    if (!reducirMovimiento) await esperar(450);

    const carta = $("#carta");
    cartaModal.className = "carta-modal";
    carta.style.transition = "none";
    carta.style.transform = "";
    carta.style.clipPath = "";
    carta.scrollTop = 0;
    cartaModal.hidden = false;
    document.body.style.overflow = "hidden";

    if (reducirMovimiento) {
      cartaModal.classList.add("abierta", "leyendo");
    } else {
      // Medimos dónde acaba el folio (centrado, tamaño real) y dónde está el sobre,
      // y colocamos el folio encogido dentro del sobre con transform (técnica FLIP).
      const f = carta.getBoundingClientRect();
      const s = cartaEscena.getBoundingClientRect();
      const escala = (s.width * 0.86) / f.width;
      const dx = (s.left + s.width / 2) - (f.left + f.width / 2);
      const arribaDentro = s.top + s.height * 0.1;                 // borde superior del folio dentro del sobre
      const dyDentro = arribaDentro + (f.height * escala) / 2 - (f.top + f.height / 2);
      const subida = s.height * 0.62;                              // cuánto asoma al salir
      // Solo se ve la parte del folio que cabe en el sobre (el resto sigue "dentro")
      const visible = (s.height * 0.86) / escala;
      const recorte = Math.max(0, f.height - visible);

      const dentro = `translate(${dx}px, ${dyDentro}px) scale(${escala})`;
      const fuera = `translate(${dx}px, ${dyDentro - subida}px) scale(${escala})`;
      carta.style.transform = dentro;
      carta.style.clipPath = `inset(0 0 ${recorte}px 0 round 6px)`;
      void carta.offsetWidth; // aplica la posición inicial sin animar

      await esperar(450);
      cartaModal.classList.add("abierta");                         // se abre la solapa

      await esperar(500);
      carta.style.transition = "transform .75s cubic-bezier(.3, .7, .3, 1)";
      carta.style.transform = fuera;                               // el folio sale del sobre

      await esperar(800);
      cartaModal.classList.add("leyendo");                         // el sobre cae
      carta.style.transition = "transform .7s cubic-bezier(.2, .8, .25, 1), clip-path .7s cubic-bezier(.2, .8, .25, 1)";
      carta.style.transform = "translate(0, 0) scale(1)";          // el folio se coloca para leer
      carta.style.clipPath = "inset(0 0 0px 0 round 6px)";
    }
    carta.focus({ preventScroll: true });

    try { localStorage.setItem(CLAVE_CARTA, "1"); } catch { /* sin almacenamiento */ }
  }

  function cerrarCarta() {
    if (!cartaAbierta) return;
    cartaAbierta = false;
    cartaModal.hidden = true;
    document.body.style.overflow = "";
    buzon.classList.remove("sacando");
    pintarBuzon();
    if (ultimoFoco) ultimoFoco.focus();
  }

  buzon.addEventListener("click", abrirCarta);
  cartaModal.addEventListener("click", (e) => { if (e.target.closest("[data-cerrar-carta]")) cerrarCarta(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && cartaAbierta) cerrarCarta(); });
  pintarBuzon();

  // ---------- Contraseña ----------
  // La contraseña no está guardada en ningún sitio: se comprueba intentando descifrar
  // un dato de control. Si es correcta, la llave se recuerda en este dispositivo.
  function montarAcceso() {
    const acceso = $("#acceso");
    const form = $("#accesoForm");
    const campo = $("#accesoClave");
    const error = $("#accesoError");
    const boton = form.querySelector(".acceso-boton");

    const entrar = (animar) => {
      document.body.classList.remove("con-acceso");
      if (animar) acceso.classList.add("fuera");
      else acceso.hidden = true;
      setTimeout(() => { acceso.hidden = true; }, 600);
    };

    if (!CIFRADO || !window.crypto || !crypto.subtle) {
      error.textContent = !CIFRADO
        ? "Faltan los regalos cifrados (recompensas/lista.js)."
        : "Abre el calendario desde su dirección https para poder entrar.";
      boton.disabled = true;
      return;
    }

    // ¿Ya entró antes en este dispositivo?
    (async () => {
      try {
        const guardada = localStorage.getItem(CLAVE_LLAVE);
        if (guardada) {
          const k = await crypto.subtle.importKey("raw", deB64(guardada), "AES-GCM", true, ["decrypt"]);
          if (await llaveValida(k)) { llave = k; entrar(false); return; }
          localStorage.removeItem(CLAVE_LLAVE);
        }
      } catch { /* sin almacenamiento o llave antigua */ }
      campo.focus();
    })();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      boton.disabled = true;
      boton.textContent = "Comprobando…";
      error.textContent = "";
      let k = null;
      try { k = await derivarLlave(campo.value.trim()); } catch { k = null; }
      const ok = k && await llaveValida(k);
      boton.disabled = false;
      boton.textContent = "Entrar";

      if (ok) {
        llave = k;
        try { localStorage.setItem(CLAVE_LLAVE, aB64(await crypto.subtle.exportKey("raw", k))); } catch { /* sin almacenamiento */ }
        campo.value = "";
        entrar(true);
      } else {
        error.textContent = "Esa no es la contraseña. Prueba otra vez.";
        campo.setAttribute("aria-invalid", "true");
        campo.select();
        form.classList.remove("sacudir");
        void form.offsetWidth;
        form.classList.add("sacudir");
      }
    });
    campo.addEventListener("input", () => {
      campo.removeAttribute("aria-invalid");
      error.textContent = "";
    });
  }

  // ---------- Inicio ----------
  montarAcceso();
  if (MODO_PRUEBA) montarPanelPrueba();
  cajas.forEach(actualizarCaja);
  actualizarCuenta();
  setInterval(actualizarCuenta, 1000);
})();
