import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

/* One reusable corporate report template, used by every "Export PDF"
   button across Reports Center -- confirmed as the explicit goal: the
   screen, the PDF, and the Excel export are three presentations of the
   exact same filtered analysis, not three separate systems. Landscape,
   since these are wide operational tables, not narrow documents.

   Structure, top to bottom: company name, report title, a metadata line
   (period/filters/generated timestamp), KPI boxes, then the main table
   with its header repeating on every page and a page number/timestamp
   footer -- exactly the corporate structure specified, not a printed
   browser screenshot. */
export function generateCorporatePDF({
  companyName = "PERRY ELLIS INTERNATIONAL — BANGLADESH",
  reportName,
  periodLabel,
  filterLabels = [], // ["Factory: AKH FASHIONS LTD", "Product Group: Men's", ...] -- only show what's actually relevant to this report
  kpis = [], // [{ label, value }]
  columns, // [{ header, key, align: "left"|"right"|"center" }]
  rows, // plain objects keyed by column.key
  totalsRow, // optional -- one object keyed like rows, rendered as the table's LAST line
  fileName,
}) {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 32;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(107, 114, 128);
  doc.text(companyName, margin, y);
  y += 20;

  doc.setFontSize(16);
  doc.setTextColor(17, 24, 39);
  doc.text(reportName, margin, y);
  y += 16;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(107, 114, 128);
  const generatedAt = new Date().toLocaleString("en-US", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  const metaLine = [periodLabel, ...filterLabels, `Generated: ${generatedAt}`].filter(Boolean).join("   |   ");
  doc.text(metaLine, margin, y, { maxWidth: pageWidth - margin * 2 });
  y += 22;

  // KPI boxes -- clean, compact boxes, not oversized dashboard cards.
  if (kpis.length) {
    const boxWidth = (pageWidth - margin * 2 - (kpis.length - 1) * 8) / kpis.length;
    const boxHeight = 42;
    kpis.forEach((k, i) => {
      const x = margin + i * (boxWidth + 8);
      doc.setDrawColor(229, 231, 235);
      doc.setFillColor(249, 250, 251);
      doc.roundedRect(x, y, boxWidth, boxHeight, 3, 3, "FD");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.setTextColor(17, 24, 39);
      doc.text(String(k.value), x + 8, y + 20);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(107, 114, 128);
      doc.text(k.label, x + 8, y + 33, { maxWidth: boxWidth - 16 });
    });
    y += boxHeight + 18;
  }

  // Main table -- proper alignment (text left, numbers/currency right,
  // dates centered), header repeats on every page automatically via
  // autoTable's own pagination, page number + timestamp in the footer.
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [columns.map(c => c.header)],
    body: rows.map(r => columns.map(c => r[c.key] ?? "")),
    /* The grand total is autoTable's `foot`, not an extra body row and not
       a KPI box above the chart -- so it prints as the closing line of the
       table and, on a multi-page report, repeats correctly at the bottom
       rather than being stranded on page 1. */
    foot: totalsRow ? [columns.map(c => totalsRow[c.key] ?? "")] : undefined,
    showFoot: totalsRow ? "lastPage" : "never",
    footStyles: { fillColor: [247, 244, 238], textColor: [27, 36, 52], fontStyle: "bold", lineWidth: { top: 1 }, lineColor: [26, 34, 51] },
    styles: { font: "helvetica", fontSize: 8, cellPadding: 4, textColor: [31, 41, 55] },
    headStyles: { fillColor: [26, 34, 51], textColor: [255, 255, 255], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [249, 250, 251] },
    columnStyles: Object.fromEntries(columns.map((c, i) => [i, { halign: c.align || "left" }])),
    didDrawPage: () => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(156, 163, 175);
      doc.text(reportName, margin, doc.internal.pageSize.getHeight() - 14);
    },
  });

  // Page numbers, done as a second pass -- confirmed by direct testing
  // that the total page count isn't actually known yet while
  // didDrawPage fires for each individual page (it reflects only the
  // count so far, producing "Page 1 of 1", "Page 2 of 2" instead of the
  // correct "Page 1 of 3", "Page 2 of 3" once the real total is known).
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(156, 163, 175);
    doc.text(`Page ${i} of ${totalPages}`, pageWidth - margin, doc.internal.pageSize.getHeight() - 14, { align: "right" });
  }

  doc.save(fileName);
}
