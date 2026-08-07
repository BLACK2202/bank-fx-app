// One-off helper to (re)generate a sample taux.xlsx like the bank would provide.
// Run: node data/make_sample_rates.js
const ExcelJS = require('exceljs');
const path = require('path');

const rows = [
  { Devise: 'USD', Achat: 3.095, Vente: 3.135, DateMaj: '2026-08-03' },
  { Devise: 'EUR', Achat: 3.375, Vente: 3.420, DateMaj: '2026-08-03' },
  { Devise: 'GBP', Achat: 3.920, Vente: 3.975, DateMaj: '2026-08-03' },
  { Devise: 'JPY', Achat: 0.0208, Vente: 0.0213, DateMaj: '2026-08-03' },
  { Devise: 'CAD', Achat: 2.245, Vente: 2.285, DateMaj: '2026-08-03' },
  { Devise: 'CHF', Achat: 3.520, Vente: 3.565, DateMaj: '2026-08-03' },
];

async function main() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Taux');
  sheet.columns = [
    { header: 'Devise', key: 'Devise' },
    { header: 'Achat', key: 'Achat' },
    { header: 'Vente', key: 'Vente' },
    { header: 'DateMaj', key: 'DateMaj' },
  ];
  rows.forEach((r) => sheet.addRow(r));
  const outPath = path.join(__dirname, 'taux.xlsx');
  await workbook.xlsx.writeFile(outPath);
  console.log('taux.xlsx written to', outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
