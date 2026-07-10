// netlify/functions/lib/pdf.ts
//
// Reusable server-side PDF toolkit in the Pure Nutra Labs house style, built on
// pdf-lib (pure JS — bundles cleanly under esbuild, no native deps). This is the
// shared rendering path the Batch Production Record generator will also use, so it
// is deliberately generic: a small layout engine (header band, section bands,
// wrapping tables with page-break, metadata + signature blocks) plus one composer,
// renderFormulaCard(), that lays out the Formula Card from values it is GIVEN.
//
// IMPORTANT: this module renders only. It performs NO formula arithmetic — every
// number it prints is produced by lib/formula.ts and passed in, so the card can
// never disagree with the MMR view or the future BPR.
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";

// ── PNL house palette ────────────────────────────────────────────────────────
function hex(n: number) {
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
export const PNL = {
  navy: hex(0x1b3a5f),
  green: hex(0x1ca04a),
  teal: hex(0x2e9bc9),
  grey: hex(0x5b6470),
  light: hex(0xeef2f6),
  white: rgb(1, 1, 1),
  ink: hex(0x1a1f28),
  rule: hex(0xc7d0da),
};

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 42;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = 54; // reserve for footer

// pdf-lib's StandardFonts use WinAnsi; keep drawn text to safe characters. Map the
// common typographic glyphs we use to ASCII so nothing ever fails to encode.
function sanitize(s: unknown): string {
  let t = String(s ?? "");
  t = t
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/[×]/g, "x")
    .replace(/[—–]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[•]/g, "-")
    .replace(/→/g, "->")
    .replace(/≈/g, "~");
  // Drop anything still outside printable Latin-1 to guarantee encodability.
  return t.replace(/[^\x20-\x7e\xa0-\xff]/g, "");
}

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  y: number; // current baseline cursor, PDF coords (from bottom)
  pageNum: number;
  title: string;
}

function widthOf(font: PDFFont, s: string, size: number) {
  return font.widthOfTextAtSize(sanitize(s), size);
}

// Greedy word-wrap to a max width, returning the wrapped lines.
function wrap(font: PDFFont, s: string, size: number, maxW: number): string[] {
  const words = sanitize(s).split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const test = cur + " " + words[i];
    if (font.widthOfTextAtSize(test, size) <= maxW) cur = test;
    else {
      lines.push(cur);
      cur = words[i];
    }
  }
  lines.push(cur);
  return lines;
}

function text(ctx: Ctx, s: string, x: number, y: number, size: number, opts: { bold?: boolean; color?: any } = {}) {
  ctx.page.drawText(sanitize(s), { x, y, size, font: opts.bold ? ctx.bold : ctx.font, color: opts.color || PNL.ink });
}

function footer(ctx: Ctx) {
  ctx.page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 24, color: PNL.light });
  ctx.page.drawLine({ start: { x: 0, y: 24 }, end: { x: PAGE_W, y: 24 }, thickness: 0.6, color: PNL.rule });
  text(ctx, "Pure Nutra Labs  -  Controlled Document  -  CONFIDENTIAL", MARGIN, 9, 7.5, { color: PNL.grey });
  const p = "Page " + ctx.pageNum;
  text(ctx, p, PAGE_W - MARGIN - widthOf(ctx.font, p, 7.5), 9, 7.5, { color: PNL.grey });
}

function newPage(ctx: Ctx, continuation: boolean) {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.pageNum += 1;
  footer(ctx);
  // Slim navy band on continuation pages.
  ctx.page.drawRectangle({ x: 0, y: PAGE_H - 28, width: PAGE_W, height: 28, color: PNL.navy });
  text(ctx, "PURE NUTRA LABS - FORMULA CARD (cont.)", MARGIN, PAGE_H - 19, 9, { bold: true, color: PNL.white });
  ctx.y = PAGE_H - 28 - 20;
}

function ensure(ctx: Ctx, need: number) {
  if (ctx.y - need < BOTTOM) newPage(ctx, true);
}

// Full-width header band with the document title.
function headerBand(ctx: Ctx) {
  ctx.page.drawRectangle({ x: 0, y: PAGE_H - 66, width: PAGE_W, height: 66, color: PNL.navy });
  ctx.page.drawRectangle({ x: 0, y: PAGE_H - 70, width: PAGE_W, height: 4, color: PNL.green });
  text(ctx, "PURE NUTRA LABS", MARGIN, PAGE_H - 30, 16, { bold: true, color: PNL.white });
  text(ctx, ctx.title, MARGIN, PAGE_H - 50, 12, { bold: true, color: PNL.teal });
  ctx.y = PAGE_H - 70 - 22;
}

// Section band (navy strip with a white title).
function sectionBand(ctx: Ctx, label: string) {
  ensure(ctx, 24 + 8);
  ctx.y -= 6;
  ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - 18, width: CONTENT_W, height: 18, color: PNL.navy });
  text(ctx, label, MARGIN + 8, ctx.y - 13, 9.5, { bold: true, color: PNL.white });
  ctx.y -= 18 + 8;
}

// Two-column metadata block of label/value pairs.
function metaBlock(ctx: Ctx, pairs: [string, string][]) {
  const colW = CONTENT_W / 2;
  const rowH = 15;
  const labelSize = 7.5;
  const valSize = 9;
  for (let i = 0; i < pairs.length; i += 2) {
    ensure(ctx, rowH);
    const top = ctx.y;
    for (let c = 0; c < 2; c++) {
      const pair = pairs[i + c];
      if (!pair) continue;
      const x = MARGIN + c * colW;
      text(ctx, pair[0].toUpperCase(), x, top - 6, labelSize, { bold: true, color: PNL.grey });
      const vx = x + Math.max(120, widthOf(ctx.bold, pair[0].toUpperCase(), labelSize) + 10);
      text(ctx, pair[1], vx, top - 6, valSize, { color: PNL.ink });
    }
    ctx.y -= rowH;
  }
  ctx.y -= 4;
}

export interface TableCol {
  header: string;
  width: number;
  align?: "left" | "right";
}

// Wrapping table with a navy header row, alternating light data rows, and
// automatic page-break (the header is redrawn on each new page).
function table(ctx: Ctx, cols: TableCol[], rows: string[][]) {
  const pad = 4;
  const hSize = 7.5;
  const dSize = 8;
  const lineH = 10;

  const drawHeader = () => {
    // Header height from the tallest wrapped header cell.
    let hLines = 1;
    const wrapped = cols.map((c) => {
      const w = wrap(ctx.bold, c.header, hSize, c.width - pad * 2);
      hLines = Math.max(hLines, w.length);
      return w;
    });
    const hH = hLines * (hSize + 2) + 6;
    ensure(ctx, hH);
    ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - hH, width: CONTENT_W, height: hH, color: PNL.navy });
    let x = MARGIN;
    cols.forEach((c, ci) => {
      wrapped[ci].forEach((ln, li) => {
        const tw = widthOf(ctx.bold, ln, hSize);
        const tx = c.align === "right" ? x + c.width - pad - tw : x + pad;
        text(ctx, ln, tx, ctx.y - 4 - hSize - li * (hSize + 2) + 2, hSize, { bold: true, color: PNL.white });
      });
      x += c.width;
    });
    ctx.y -= hH;
  };

  drawHeader();
  rows.forEach((row, ri) => {
    const wrapped = cols.map((c, ci) => wrap(ctx.font, row[ci] ?? "", dSize, c.width - pad * 2));
    const nLines = Math.max(1, ...wrapped.map((w) => w.length));
    const rowH = nLines * lineH + 4;
    if (ctx.y - rowH < BOTTOM) {
      newPage(ctx, true);
      drawHeader();
    }
    if (ri % 2 === 0) ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - rowH, width: CONTENT_W, height: rowH, color: PNL.light });
    let x = MARGIN;
    cols.forEach((c, ci) => {
      wrapped[ci].forEach((ln, li) => {
        const tw = widthOf(ctx.font, ln, dSize);
        const tx = c.align === "right" ? x + c.width - pad - tw : x + pad;
        text(ctx, ln, tx, ctx.y - 3 - dSize - li * lineH + 2, dSize, { color: PNL.ink });
      });
      x += c.width;
    });
    ctx.y -= rowH;
  });
  // Bottom rule.
  ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y }, end: { x: MARGIN + CONTENT_W, y: ctx.y }, thickness: 0.6, color: PNL.rule });
  ctx.y -= 6;
}

// A compact "totals / summary" panel of label:value rows inside a light box.
function summaryBox(ctx: Ctx, rows: [string, string, boolean?][]) {
  const rowH = 15;
  const boxH = rows.length * rowH + 8;
  ensure(ctx, boxH);
  ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - boxH, width: CONTENT_W, height: boxH, color: PNL.light, borderColor: PNL.rule, borderWidth: 0.6 });
  let ry = ctx.y - 4;
  rows.forEach(([label, value, emphasize]) => {
    text(ctx, label, MARGIN + 8, ry - 9, 8.5, { bold: true, color: PNL.navy });
    const vSize = emphasize ? 10 : 8.5;
    const tw = widthOf(ctx.bold, value, vSize);
    text(ctx, value, MARGIN + CONTENT_W - 8 - tw, ry - 9, vSize, { bold: true, color: emphasize ? PNL.green : PNL.ink });
    ry -= rowH;
  });
  ctx.y -= boxH + 6;
}

function noteLine(ctx: Ctx, s: string) {
  const lines = wrap(ctx.font, s, 7.5, CONTENT_W);
  ensure(ctx, lines.length * 10 + 4);
  lines.forEach((ln) => {
    text(ctx, ln, MARGIN, ctx.y - 8, 7.5, { color: PNL.grey });
    ctx.y -= 10;
  });
  ctx.y -= 4;
}

// Two wet-sign lines with a printed "Name / Title" caption under each.
function signatureBlock(ctx: Ctx, roles: string[]) {
  ensure(ctx, 70);
  ctx.y -= 8;
  const colW = CONTENT_W / 2;
  const lineY = ctx.y - 34;
  roles.forEach((role, i) => {
    const x = MARGIN + i * colW;
    text(ctx, role, x, ctx.y - 6, 9, { bold: true, color: PNL.navy });
    ctx.page.drawLine({ start: { x, y: lineY }, end: { x: x + colW - 30, y: lineY }, thickness: 0.8, color: PNL.ink });
    text(ctx, "Signature", x, lineY - 11, 7, { color: PNL.grey });
    const nameLineY = lineY - 30;
    ctx.page.drawLine({ start: { x, y: nameLineY }, end: { x: x + colW - 30, y: nameLineY }, thickness: 0.8, color: PNL.ink });
    text(ctx, "Name / Title", x, nameLineY - 11, 7, { color: PNL.grey });
  });
  ctx.y = lineY - 30 - 16;
}

// ── PUBLIC: Formula Card composer ────────────────────────────────────────────
export interface FormulaCardData {
  meta: {
    productName: string;
    productCode: string;
    mmrId: string;
    revision: string | number;
    status: string;
    quoteRevisionId: string;
    capsulesPerBatch: string;
    dosesPerBatch: string;
    capsuleSpec: string;
    capsuleWeightMg: string;
    generatedDate: string;
  };
  formulaLines: { itemNumber: string; name: string; labelClaimMg: string; potency: string; overagePct: string; totalMgPerDose: string; mgPerCapsule: string }[];
  summary: { totalMgPerDoseAll: string; mgPerCapsuleAll: string; grossTargetMg: string; grossLowMg: string; grossHighMg: string; capsulesPerDose: string };
  batchLines: { itemNumber: string; name: string; formulaBatchQtyKg: string; mfgOverageKg: string; mfgOveragePct: string; weighoutTargetKg: string }[];
  totals: { formulaTheoreticalKg: string; chargedWeightKg: string; capsules: string; bottles: string };
}

export async function renderFormulaCard(data: FormulaCardData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const ctx: Ctx = { doc, page, font, bold, y: PAGE_H, pageNum: 1, title: "FORMULA CARD" };
  footer(ctx);
  headerBand(ctx);

  const m = data.meta;
  metaBlock(ctx, [
    ["Product Name", m.productName],
    ["Product Code", m.productCode],
    ["MMR No. / Revision", `${m.mmrId} (Rev ${m.revision})`],
    ["Status", m.status],
    ["Quote / Revision ID", m.quoteRevisionId || "-"],
    ["Batch Size", `${m.capsulesPerBatch} capsules  /  ${m.dosesPerBatch} doses`],
    ["Capsule Spec", m.capsuleSpec || "-"],
    ["Capsule Weight (mg)", m.capsuleWeightMg || "-"],
    ["Date Generated", m.generatedDate],
    ["", ""],
  ]);

  // SECTION 1 — FORMULA (per dose / per capsule), batch-size-independent.
  sectionBand(ctx, "SECTION 1  -  FORMULA (PER DOSE / PER CAPSULE)");
  table(
    ctx,
    [
      { header: "Item #", width: 44 },
      { header: "Ingredient", width: 150 },
      { header: "Label Claim (mg)", width: 66, align: "right" },
      { header: "Potency", width: 52, align: "right" },
      { header: "Formula Overage", width: 68, align: "right" },
      { header: "Total mg/Dose (computed)", width: 74, align: "right" },
      { header: "mg/Capsule (computed)", width: 74, align: "right" },
    ],
    data.formulaLines.map((l) => [l.itemNumber || "-", l.name, l.labelClaimMg, l.potency, l.overagePct, l.totalMgPerDose, l.mgPerCapsule]),
  );
  summaryBox(ctx, [
    ["Total mg per Dose (computed)", data.summary.totalMgPerDoseAll + " mg"],
    ["mg per Capsule (computed)", data.summary.mgPerCapsuleAll + " mg"],
    ["Gross Weight Target (computed)", data.summary.grossTargetMg + " mg"],
    ["Gross Weight Low (computed)", data.summary.grossLowMg + " mg"],
    ["Gross Weight High (computed)", data.summary.grossHighMg + " mg"],
    ["Capsules per Dose", data.summary.capsulesPerDose],
  ]);

  // SECTION 2 — BATCH SCALE (mg -> kg) at the selected batch size.
  sectionBand(ctx, `SECTION 2  -  BATCH SCALE @ ${m.capsulesPerBatch} CAPSULES`);
  table(
    ctx,
    [
      { header: "Item #", width: 46 },
      { header: "Ingredient", width: 168 },
      { header: "Formula Batch Qty (kg)", width: 90, align: "right" },
      { header: "Mfg Overage (kg)", width: 78, align: "right" },
      { header: "Mfg Overage (%)", width: 66, align: "right" },
      { header: "Weigh-Out Target (kg)", width: 80, align: "right" },
    ],
    data.batchLines.map((l) => [l.itemNumber || "-", l.name, l.formulaBatchQtyKg, l.mfgOverageKg, l.mfgOveragePct, l.weighoutTargetKg]),
  );
  summaryBox(ctx, [
    ["Formula Theoretical Weight (kg) - exact minimum sum", data.totals.formulaTheoreticalKg + " kg"],
    ["Charged Weight / Weigh-Out Total (kg) - blending-yield basis", data.totals.chargedWeightKg + " kg", true],
    ["Batch Output - Capsules", data.totals.capsules],
    ["Batch Output - Bottles (at MMR bottle count)", data.totals.bottles],
  ]);
  noteLine(
    ctx,
    "Weigh-out targets are set to practical whole quantities at or above the formula minimum; the difference is documented manufacturing overage. This simplifies dispensing and improves batch reproducibility.",
  );

  // SECTION 3 — SIGNATURES.
  sectionBand(ctx, "SECTION 3  -  SIGNATURES");
  signatureBlock(ctx, ["Prepared By", "Approved By"]);

  return await doc.save();
}
