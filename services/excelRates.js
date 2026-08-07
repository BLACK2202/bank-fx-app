const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");

const RATES_PATH =
  process.env.RATES_FILE_PATH ||
  path.join(__dirname, "..", "data", "taux.xlsx");

/**
 * Reads the bank-provided Excel sheet fresh from disk (no caching), as required
 * before every FX operation, so an agency can never work off a stale rate.
 * Expected columns per row: Devise | Achat | Vente | DateMaj
 */
async function readRatesFresh() {
  if (!fs.existsSync(RATES_PATH)) {
    throw new Error(`Fichier de taux introuvable : ${RATES_PATH}`);
  }
  const stat = fs.statSync(RATES_PATH);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(RATES_PATH);
  const sheet = workbook.worksheets[0];

  const headerRow = sheet.getRow(1).values; // sparse array, index 0 unused
  const colIndex = {};
  headerRow.forEach((val, idx) => {
    if (val) colIndex[String(val).trim()] = idx;
  });

  const rates = {};
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const values = row.values;
    const devise = String(values[colIndex.Devise] || "")
      .trim()
      .toUpperCase();
    if (!devise) return;
    const achat = Number(values[colIndex.Achat]);
    const vente = Number(values[colIndex.Vente]);
    const dateMajRaw = values[colIndex.DateMaj];
    rates[devise] = {
      achat,
      vente,
      dateMaj: dateMajRaw ? String(dateMajRaw) : null,
    };
  });

  return {
    rates,
    fileModifiedAt: stat.mtime.toISOString(),
    checkedAt: new Date().toISOString(),
    sourcePath: RATES_PATH,
  };
}

/**
 * Applies the bank's FX quoting convention:
 * - client ACHAT (buys devise from the bank)  -> bank's VENTE rate applies
 * - client VENTE (sells devise to the bank)   -> bank's ACHAT rate applies
 */
async function getSpotRate(devise, sens) {
  if (!devise || devise === "TND") {
    throw new Error("Veuillez choisir une devise source autre que TND.");
  }
  const snapshot = await readRatesFresh();
  const entry = snapshot.rates[devise];
  if (!entry) {
    throw new Error(
      `Aucun taux disponible pour la devise ${devise} dans le fichier du siege.`,
    );
  }
  const taux = sens === "achat" ? entry.vente : entry.achat;
  if (!taux || Number.isNaN(taux)) {
    throw new Error(`Taux invalide pour ${devise} dans le fichier du siege.`);
  }
  return {
    taux,
    devise,
    sens,
    dateMajFichier: entry.dateMaj,
    fileModifiedAt: snapshot.fileModifiedAt,
    checkedAt: snapshot.checkedAt,
  };
}

module.exports = { readRatesFresh, getSpotRate, RATES_PATH };
