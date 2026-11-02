const XLSX = require('xlsx');

// Server-side counterpart to client/src/api/exportXlsx.js's exportToXlsx —
// same column/number-formatting shape, but returns an in-memory Buffer
// instead of triggering a browser download, so it can be attached straight
// to a Telegram sendDocument call.
function buildXlsxBuffer({ sheetName = 'Sheet1', columns, rows }) {
  const headers = columns.map((c) => c.header);
  const data = rows.map((row) => columns.map((c) => row[c.key]));
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...data]);

  sheet['!cols'] = columns.map((c) => ({ wch: c.width || 14 }));

  const NUMBER_FORMATS = {
    currency: `#,##0" so'm"`,
    number: '#,##0',
  };
  columns.forEach((c, colIdx) => {
    const numFmt = NUMBER_FORMATS[c.format];
    if (!numFmt) return;
    for (let r = 1; r <= data.length; r++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c: colIdx })];
      if (cell) cell.z = numFmt;
    }
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildXlsxBuffer };
