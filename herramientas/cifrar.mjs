// Cifra los regalos con la contraseña para que solo se puedan ver al entrar en la web.
//
// Uso (desde la carpeta del proyecto):
//   node herramientas/cifrar.mjs
// o haz doble clic en "cifrar-regalos.cmd".
//
// Lee:     regalos-originales/1.jpg, 2.mp4, ... 28.png   (un archivo por día, nombre = número)
//          regalos-originales/textos.json                 (opcional: títulos y mensajes por día)
// Escribe: recompensas/1.dat ... 28.dat                   (archivos cifrados, ilegibles sin contraseña)
//          recompensas/lista.js                           (datos cifrados que usa la web)
//
// La carpeta "regalos-originales" NO se debe subir a internet: solo "recompensas".

import { webcrypto as crypto } from "node:crypto";
import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGEN = path.join(RAIZ, "regalos-originales");
const DESTINO = path.join(RAIZ, "recompensas");
const TOTAL_DIAS = 28;
const ITERACIONES = 400000;

const TIPOS = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", ogv: "video/ogg",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac",
  flac: "audio/flac", opus: "audio/opus",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8"
};

const b64 = (buf) => Buffer.from(buf).toString("base64");
const enc = new TextEncoder();

async function derivarClave(clave, sal) {
  const base = await crypto.subtle.importKey("raw", enc.encode(clave), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: sal, iterations: ITERACIONES, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
}

async function cifrar(clave, datos) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, clave, datos);
  return { iv, cifrado: new Uint8Array(cifrado) };
}

async function pedirClave() {
  if (process.env.CLAVE) return process.env.CLAVE;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question("Contraseña de la web: ");
  const b = await rl.question("Repítela: ");
  rl.close();
  if (a !== b) throw new Error("Las contraseñas no coinciden.");
  if (!a) throw new Error("La contraseña no puede estar vacía.");
  return a;
}

async function main() {
  if (!existsSync(ORIGEN)) await mkdir(ORIGEN, { recursive: true });
  await mkdir(DESTINO, { recursive: true });

  const clave = await pedirClave();
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const llave = await derivarClave(clave, sal);

  // Textos opcionales
  let textos = {};
  const rutaTextos = path.join(ORIGEN, "textos.json");
  if (existsSync(rutaTextos)) textos = JSON.parse(await readFile(rutaTextos, "utf8"));

  // Archivos del 1 al 28 (el nombre, sin extensión, es el número del día)
  const archivos = {};
  for (const nombre of await readdir(ORIGEN)) {
    const m = nombre.match(/^0*(\d{1,2})\.([a-z0-9]+)$/i);
    if (!m) continue;
    const dia = Number(m[1]);
    if (dia < 1 || dia > TOTAL_DIAS) continue;
    if (archivos[dia]) throw new Error(`Hay dos archivos para el día ${dia}: ${archivos[dia]} y ${nombre}`);
    archivos[dia] = nombre;
  }

  // Borramos los cifrados anteriores
  for (const nombre of await readdir(DESTINO)) {
    if (nombre.endsWith(".dat")) await rm(path.join(DESTINO, nombre));
  }

  // Verificador: sirve para comprobar la contraseña en la web
  const verif = await cifrar(llave, enc.encode("calendario-ok"));
  const salida = {
    version: 1,
    sal: b64(sal),
    iteraciones: ITERACIONES,
    verificador: { iv: b64(verif.iv), datos: b64(verif.cifrado) },
    regalos: {}
  };

  const resumen = [];
  for (let dia = 1; dia <= TOTAL_DIAS; dia++) {
    const nombre = archivos[dia];
    const extra = textos[dia] || textos[String(dia)] || {};
    if (!nombre && !extra.titulo && !extra.mensaje) continue;

    const meta = { titulo: extra.titulo || "", mensaje: extra.mensaje || "" };
    const entrada = {};

    if (nombre) {
      const ext = nombre.split(".").pop().toLowerCase();
      meta.tipo = TIPOS[ext] || "application/octet-stream";
      meta.nombre = `regalo-${dia}.${ext}`;
      const contenido = await readFile(path.join(ORIGEN, nombre));
      const { iv, cifrado } = await cifrar(llave, contenido);
      await writeFile(path.join(DESTINO, `${dia}.dat`), cifrado);
      entrada.archivo = `${dia}.dat`;
      entrada.iv = b64(iv);
      resumen.push(`  Día ${String(dia).padStart(2)}: ${nombre} (${(contenido.length / 1048576).toFixed(1)} MB)`);
    } else {
      resumen.push(`  Día ${String(dia).padStart(2)}: solo texto`);
    }

    const m = await cifrar(llave, enc.encode(JSON.stringify(meta)));
    entrada.meta = { iv: b64(m.iv), datos: b64(m.cifrado) };
    salida.regalos[dia] = entrada;
  }

  const js = "// Generado por herramientas/cifrar.mjs. No editar a mano: todo está cifrado.\n" +
    "window.RECOMPENSAS_CIFRADAS = " + JSON.stringify(salida, null, 2) + ";\n";
  await writeFile(path.join(DESTINO, "lista.js"), js);

  const faltan = [];
  for (let d = 1; d <= TOTAL_DIAS; d++) if (!salida.regalos[d]) faltan.push(d);
  console.log(`\nListo. Regalos cifrados: ${Object.keys(salida.regalos).length} de ${TOTAL_DIAS}.`);
  if (resumen.length) console.log(resumen.join("\n"));
  if (faltan.length) console.log(`  Sin regalo todavía: ${faltan.join(", ")}`);
  console.log("\nSube a internet la carpeta 'recompensas', nunca 'regalos-originales'.");
}

main().catch((e) => { console.error("\nError: " + e.message); process.exitCode = 1; });
