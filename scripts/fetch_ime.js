// scripts/fetch_ime.js
import fs from "fs";
import path from "path";

const IME_BASE = "https://www.justiciachaco.gov.ar/IME/Resistencia/Civil";
const TURNOS = ["Matutino", "Vespertino"];
const JUZGADOS = JSON.parse(process.env.JUZGADOS_JSON || "[]");
const TZ = process.env.TZ || "America/Argentina/Cordoba";
const PROXY_BASE = process.env.PROXY_BASE || ""; // ej: "https://...workers.dev/?url="

function ymdPartsInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const [y, m, day] = fmt.format(d).split("-");
  return { y, m, d: day, iso: `${y}-${m}-${day}` };
}
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function sanitize(s) { return (s || "").trim(); }

function parseImeText(txt) {
  const clean = txt.replace(/\r\n/g, "\n");
  const blocks = clean.split(/\n-{5,}\n/);
  const out = [];
  for (const b of blocks) {
    const m = (re) => (b.match(re)?.[1] || "").trim();
    const expediente = sanitize(m(/EXPEDIENTE:\[\s*([^\]]+)\s*\]/i).replace(/^'|'+$/g, ""));
    const caratula   = sanitize(m(/CARATULA:\[\s*'?(.*?)'?\s*\]/i));
    const descripcion= sanitize(m(/DESCRIPCION:\[\s*'?(.*?)'?\s*\]/i));
    const radicado   = sanitize(m(/RADICADO EN:\[\s*'?(.*?)'?\s*\]/i));
    const tramite    = sanitize(m(/TRAMITE DE:\[\s*'?(.*?)'?\s*\]/i));
    if (!expediente && !caratula && !descripcion) continue;
    out.push({ expediente, caratula, descripcion, radicado, tramite });
  }
  return out;
}

// fetch con timeout + reintentos
async function fetchWithTimeout(url, { timeoutMs = 25000, headers = {}, tries = 3, backoffMs = 900 } = {}) {
  for (let i = 1; i <= tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
      clearTimeout(t);
      if (res.status === 200) {
        const buf = Buffer.from(await res.arrayBuffer());
        let txt = new TextDecoder("utf-8").decode(buf);
        if (/[ÃÂ]/.test(txt)) txt = new TextDecoder("latin1").decode(buf);
        return txt;
      }
      if (res.status === 404 || res.status >= 500) {
        console.log(`   intento ${i}/${tries} -> HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, backoffMs * i));
        continue;
      }
      console.log(`   intento ${i}/${tries} -> HTTP ${res.status} (sin reintento)`);
      return null;
    } catch (e) {
      clearTimeout(t);
      console.log(`   intento ${i}/${tries} -> error: ${e?.message || e}`);
      await new Promise(r => setTimeout(r, backoffMs * i));
    }
  }
  return null;
}

function buildCandidates(httpsUrl) {
  const out = [httpsUrl];
  if (httpsUrl.startsWith("https://")) out.push("http://" + httpsUrl.slice("https://".length));
  if (PROXY_BASE) out.push(PROXY_BASE + encodeURIComponent(httpsUrl)); // último intento: tu Worker
  return out;
}

async function fetchTxt(httpsUrl) {
  const headers = {
    "User-Agent": "Mozilla/5.0 GitHubActions/IME-Mirror",
    "Referer": "https://www.justiciachaco.gov.ar/",
    "Accept": "text/plain,*/*;q=0.8"
  };
  for (const u of buildCandidates(httpsUrl)) {
    console.log("=> probando", u);
    const txt = await fetchWithTimeout(u, { headers, timeoutMs: 25000, tries: 3, backoffMs: 1000 });
    if (txt) return txt;
  }
  return null;
}

async function main() {
  const { y, m, d, iso } = ymdPartsInTZ(new Date(), TZ);
  const dayDirTxt  = path.join("data", `${y}-${m}-${d}`);
  const dayDirJson = path.join("json", `${y}-${m}-${d}`);
  ensureDir(dayDirTxt); ensureDir(dayDirJson);

  const all = [];
  for (const juz of JUZGADOS) {
    for (const turno of TURNOS) {
      const url = `${IME_BASE}/${juz.path}/Juzgado_Civil_${juz.n}_${y}_${m}_${d}_${turno}.txt`;
      console.log("=>", url);
      const txt = await fetchTxt(url);
      if (!txt) { console.log("   (no disponible o sin conectividad)"); continue; }

      const txtName = `Juzgado_Civil_${juz.n}_${y}_${m}_${d}_${turno}.txt`;
      fs.writeFileSync(path.join(dayDirTxt, txtName), txt, "utf8");

      const items = parseImeText(txt).map(o => ({
        fechaPublicacion: iso, turno, juzgado: juz.etiqueta, ...o, fuenteURL: url
      }));
      const jsonName = `Juzgado_Civil_${juz.n}_${y}_${m}_${d}_${turno}.json`;
      fs.writeFileSync(path.join(dayDirJson, jsonName), JSON.stringify(items, null, 2), "utf8");
      all.push(...items);
    }
  }
  fs.writeFileSync(path.join(dayDirJson, `all.json`), JSON.stringify(all, null, 2), "utf8");
  console.log(`Listo: ${all.length} items en json/${y}-${m}-${d}/all.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
