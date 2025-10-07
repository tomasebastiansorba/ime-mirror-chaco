// scripts/fetch_ime.js
import fs from "fs";
import path from "path";

const IME_BASE = "https://www.justiciachaco.gov.ar/IME/Resistencia/Civil";
const TURNOS = ["Matutino", "Vespertino"];
// el robot (workflow) le pasa esta lista por variable de entorno
const JUZGADOS = JSON.parse(process.env.JUZGADOS_JSON || "[]");
const TZ = process.env.TZ || "America/Argentina/Cordoba";

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
    const caratula = sanitize(m(/CARATULA:\[\s*'?(.*?)'?\s*\]/i));
    const descripcion = sanitize(m(/DESCRIPCION:\[\s*'?(.*?)'?\s*\]/i));
    const radicado = sanitize(m(/RADICADO EN:\[\s*'?(.*?)'?\s*\]/i));
    const tramite = sanitize(m(/TRAMITE DE:\[\s*'?(.*?)'?\s*\]/i));
    if (!expediente && !caratula && !descripcion) continue;
    out.push({ expediente, caratula, descripcion, radicado, tramite });
  }
  return out;
}

// baja un TXT y si los acentos salen mal, intenta latin1
async function fetchTxt(url) {
  const headers = {
    "User-Agent": "Mozilla/5.0 GitHubActions/IME-Mirror",
    "Referer": "https://www.justiciachaco.gov.ar/",
    "Accept": "text/plain,*/*;q=0.8"
  };
  for (const attempt of [1,2]) {
    const res = await fetch(url, { headers });
    if (res.status === 200) {
      const buf = Buffer.from(await res.arrayBuffer());
      let txt = new TextDecoder("utf-8").decode(buf);
      if (/[ÃÂ]/.test(txt)) txt = new TextDecoder("latin1").decode(buf);
      return txt;
    }
    if (res.status >= 500 || res.status === 404) {
      await new Promise(r => setTimeout(r, 800 * attempt));
      continue;
    }
    return null;
  }
  return null;
}

async function main() {
  const { y, m, d, iso } = ymdPartsInTZ(new Date(), TZ);
  const dayDirTxt = path.join("data", `${y}-${m}-${d}`);
  const dayDirJson = path.join("json", `${y}-${m}-${d}`);
  ensureDir(dayDirTxt); ensureDir(dayDirJson);

  const all = [];
  for (const juz of JUZGADOS) {
    for (const turno of TURNOS) {
      const url = `${IME_BASE}/${juz.path}/Juzgado_Civil_${juz.n}_${y}_${m}_${d}_${turno}.txt`;
      console.log("=>", url);
      const txt = await fetchTxt(url);
      if (!txt) { console.log("   (no disponible)"); continue; }

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
