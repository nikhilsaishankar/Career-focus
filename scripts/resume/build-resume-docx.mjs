#!/usr/bin/env node
// build-resume-docx.mjs — render the canonical H-format resume as a proper
// Microsoft Word (.docx) file, matching the layout/typography of
// templates/cv-template-h.html (Arial, black headings, hairline section
// rules, blue profile links, grey meta text).
//
// Usage: node scripts/resume/build-resume-docx.mjs <content.json> <output.docx> [--field=value ...]
//
// Optional --field=value args override a single top-level content field for
// THIS docx only (e.g. --email=alt@example.com) without touching the source
// JSON — used when the .docx needs to diverge from the .pdf on one field
// (per Nikhil 2026-08-12: docx-only email, keep the JSON/.pdf untouched).

import { readFileSync, writeFileSync } from "node:fs";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  ExternalHyperlink,
  UnderlineType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  VerticalAlign,
  TableLayoutType,
} from "docx";

const [, , contentPath, outPath, ...rest] = process.argv;
if (!contentPath || !outPath) {
  console.error("Usage: node build-resume-docx.mjs <content.json> <output.docx> [--field=value ...]");
  process.exit(1);
}

const c = JSON.parse(readFileSync(contentPath, "utf8"));

for (const arg of rest) {
  const m = /^--([a-zA-Z_]+)=(.*)$/.exec(arg);
  if (!m) continue;
  c[m[1]] = m[2];
}

const FONT = "Arial";
const BLACK = "1A1A1A";
const NEAR_BLACK = "111111";
const GREY = "444444";
const MID_GREY = "666666";
const RULE_GREY = "CFCFCF";
const BLUE = "1155CC";

// Word uses half-points for font sizes.
const pt = (n) => Math.round(n * 2);

const cleanPhoneHref = (p) => `tel:${String(p).replace(/[^+\d]/g, "")}`;

// Split "**bold**" markers into runs (mirrors rich() in build-resume.mjs).
function richRuns(text, opts = {}) {
  const parts = String(text).split(/(\*\*.+?\*\*)/g).filter((s) => s !== "");
  return parts.map((part) => {
    const isBold = part.startsWith("**") && part.endsWith("**");
    const t = isBold ? part.slice(2, -2) : part;
    return new TextRun({ text: t, font: FONT, size: pt(opts.size ?? 10), color: opts.color ?? BLACK, bold: isBold || !!opts.bold });
  });
}

// Custom bullet list: the library's default `bullet: {level:0}` shorthand
// renders the "•" glyph at full paragraph font size (10pt), which prints
// much bigger/heavier than the browser's native <ul> disc at the same font
// size (the PDF path). Defining our own numbering level lets us shrink just
// the bullet glyph while keeping body text at 10pt, matching the PDF look.
const BULLET_REF = "resume-bullet";
const bulletProps = { reference: BULLET_REF, level: 0 };

// A4 page (11907 twips) minus 720-twip side margins = 10467 twips of usable
// width — needed to size the borderless two-column "rows" below.
const CONTENT_WIDTH = 10467;

// Right-aligning a date next to a name via a `\t` tab stop is NOT reliable
// across docx renderers — it worked for short names and silently collapsed
// to a single space for longer ones (e.g. "Dignity Of NobleFeb 2023..."),
// because a right tab stop only pushes content if the preceding run hasn't
// already passed the stop, and different engines compute that width
// differently. A borderless two-cell table is the standard, universally
// supported way to get a left block + a right-aligned block on one line in
// docx (Word/Google Docs/LibreOffice/Pages all agree on table layout).
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const NO_BORDERS = {
  top: NO_BORDER,
  bottom: NO_BORDER,
  left: NO_BORDER,
  right: NO_BORDER,
  insideHorizontal: NO_BORDER,
  insideVertical: NO_BORDER,
};

function splitRow(leftChildren, rightChildren, spacing) {
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [Math.round(CONTENT_WIDTH * 0.7), Math.round(CONTENT_WIDTH * 0.3)],
    // Word's default table layout is "autofit to contents," which silently
    // ignores the explicit column widths below (that's why the date glued
    // itself to the company name). Fixed layout forces the widths to hold.
    layout: TableLayoutType.FIXED,
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: Math.round(CONTENT_WIDTH * 0.7), type: WidthType.DXA },
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            borders: NO_BORDERS,
            verticalAlign: VerticalAlign.BOTTOM,
            children: [new Paragraph({ spacing, children: leftChildren })],
          }),
          new TableCell({
            width: { size: Math.round(CONTENT_WIDTH * 0.3), type: WidthType.DXA },
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            borders: NO_BORDERS,
            verticalAlign: VerticalAlign.BOTTOM,
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing, children: rightChildren })],
          }),
        ],
      }),
    ],
  });
}

const sectionTitle = (text) =>
  new Paragraph({
    spacing: { before: 240, after: 160 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE_GREY, space: 4 },
    },
    children: [
      new TextRun({ text: text.toUpperCase(), font: FONT, size: pt(11), bold: true, color: "000000" }),
    ],
  });

// --- Header -----------------------------------------------------------
const nameParagraph = new Paragraph({
  spacing: { after: 20 },
  children: [new TextRun({ text: c.name, font: FONT, size: pt(22), bold: true, color: "000000" })],
});

const titleParagraph = new Paragraph({
  spacing: { after: 80 },
  children: [new TextRun({ text: c.title || "", font: FONT, size: pt(13), bold: true, color: BLACK })],
});

const contactChildren = [];
const pushSep = () => contactChildren.push(new TextRun({ text: "  |  ", font: FONT, size: pt(9), color: "BBBBBB" }));

const contactPieces = [];
if (c.phone) {
  contactPieces.push(
    new ExternalHyperlink({
      link: cleanPhoneHref(c.phone),
      children: [new TextRun({ text: c.phone_display || c.phone, font: FONT, size: pt(9), color: GREY })],
    }),
  );
}
if (c.email) {
  contactPieces.push(
    new ExternalHyperlink({
      link: `mailto:${c.email}`,
      children: [new TextRun({ text: c.email_display || c.email, font: FONT, size: pt(9), color: GREY })],
    }),
  );
}
if (c.linkedin_display) {
  contactPieces.push(
    new ExternalHyperlink({
      link: c.linkedin_url || "#",
      children: [new TextRun({ text: c.linkedin_display, font: FONT, size: pt(9), color: BLUE })],
    }),
  );
}
if (c.github_display) {
  contactPieces.push(
    new ExternalHyperlink({
      link: c.github_url || "#",
      children: [new TextRun({ text: c.github_display, font: FONT, size: pt(9), color: BLUE })],
    }),
  );
}
if (c.medium_display) {
  contactPieces.push(
    new ExternalHyperlink({
      link: c.medium_url || "#",
      children: [new TextRun({ text: c.medium_display, font: FONT, size: pt(9), color: BLUE })],
    }),
  );
}
if (c.portfolio_display) {
  contactPieces.push(
    new ExternalHyperlink({
      link: c.portfolio_url || "#",
      children: [new TextRun({ text: c.portfolio_display, font: FONT, size: pt(9), color: BLUE })],
    }),
  );
}
if (c.location) {
  contactPieces.push(new TextRun({ text: c.location, font: FONT, size: pt(9), color: GREY }));
}

contactPieces.forEach((piece, i) => {
  if (i > 0) pushSep();
  contactChildren.push(piece);
});

const contactParagraph = new Paragraph({ spacing: { after: 200 }, children: contactChildren });

// --- Summary ------------------------------------------------------------
const summarySection = [
  sectionTitle("Professional Summary"),
  new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 120 },
    children: richRuns(c.summary || "", { size: 10 }),
  }),
];

// --- Skills ---------------------------------------------------------------
const skillsSection = [
  sectionTitle("Skills"),
  ...(c.skills || []).map(
    (s) =>
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: `${s.category}: `, font: FONT, size: pt(10), bold: true, color: NEAR_BLACK }),
          new TextRun({ text: (s.items || []).join(", "), font: FONT, size: pt(10), color: BLACK }),
        ],
      }),
  ),
];

// --- Experience -----------------------------------------------------------
function jobParagraphs(j) {
  const out = [
    splitRow(
      [new TextRun({ text: j.company, font: FONT, size: pt(11), bold: true, color: NEAR_BLACK })],
      [new TextRun({ text: j.period, font: FONT, size: pt(9.5), color: MID_GREY })],
      { before: 160, after: 20 },
    ),
    new Paragraph({
      spacing: { after: 80 },
      children: [
        new TextRun({ text: j.role, font: FONT, size: pt(10), bold: true, color: "222222" }),
        ...(j.location
          ? [new TextRun({ text: `  · ${j.location}`, font: FONT, size: pt(9.5), color: MID_GREY })]
          : []),
      ],
    }),
    ...(j.bullets || []).map(
      (b) =>
        new Paragraph({
          numbering: bulletProps,
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: 60 },
          children: richRuns(b, { size: 10 }),
        }),
    ),
  ];
  return out;
}

const experienceSection = [sectionTitle("Work Experience"), ...(c.experience || []).flatMap(jobParagraphs)];

// --- Projects ---------------------------------------------------------------
function projectParagraphs(p) {
  const titleChildren = p.url
    ? [
        new ExternalHyperlink({
          link: p.url,
          children: [new TextRun({ text: p.title, font: FONT, size: pt(10.5), bold: true, color: NEAR_BLACK })],
        }),
      ]
    : [new TextRun({ text: p.title, font: FONT, size: pt(10.5), bold: true, color: NEAR_BLACK })];

  const out = [new Paragraph({ spacing: { before: 140, after: 60 }, children: titleChildren })];
  if (p.bullets) {
    out.push(
      ...p.bullets.map(
        (b) =>
          new Paragraph({
            numbering: bulletProps,
            alignment: AlignmentType.JUSTIFIED,
            spacing: { after: 60 },
            children: richRuns(b, { size: 10 }),
          }),
      ),
    );
  } else if (p.desc) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        spacing: { after: 60 },
        children: richRuns(p.desc, { size: 10 }),
      }),
    );
  }
  return out;
}

const projectsSection =
  (c.projects || []).length > 0 ? [sectionTitle("Projects"), ...(c.projects || []).flatMap(projectParagraphs)] : [];

// --- Education ---------------------------------------------------------------
function eduParagraphs(e) {
  const out = [
    splitRow(
      [new TextRun({ text: e.title, font: FONT, size: pt(10.5), bold: true, color: NEAR_BLACK })],
      [new TextRun({ text: e.year, font: FONT, size: pt(9.5), color: MID_GREY })],
      { before: 140, after: 20 },
    ),
    new Paragraph({
      spacing: { after: 40 },
      children: [new TextRun({ text: e.org, font: FONT, size: pt(10), color: BLACK })],
    }),
  ];
  if (e.desc) {
    out.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [new TextRun({ text: e.desc, font: FONT, size: pt(10), color: BLACK })],
      }),
    );
  }
  return out;
}

const educationSection =
  (c.education || []).length > 0 ? [sectionTitle("Education"), ...(c.education || []).flatMap(eduParagraphs)] : [];

// --- Certifications ------------------------------------------------------
const certificationsSection =
  (c.certifications || []).length > 0
    ? [
        sectionTitle("Certifications"),
        ...(c.certifications || []).map((x) =>
          splitRow(
            [new TextRun({ text: `${x.title} — ${x.org}`, font: FONT, size: pt(10), color: BLACK })],
            [new TextRun({ text: x.year, font: FONT, size: pt(9.5), color: MID_GREY })],
            { after: 60 },
          ),
        ),
      ]
    : [];

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: FONT, size: pt(10), color: BLACK } },
    },
  },
  numbering: {
    config: [
      {
        reference: BULLET_REF,
        levels: [
          {
            level: 0,
            format: "bullet",
            text: "•",
            alignment: AlignmentType.LEFT,
            style: {
              // 9pt Arial "•" against 10pt body text matches the PDF's
              // browser-rendered <ul> disc almost exactly in weight/size.
              // (The library's default bullet used the Symbol font, which
              // renders visibly oversized vs. Arial at the same point size —
              // that was the real source of the "too big" bullets, not the
              // point size itself.)
              run: { font: FONT, size: pt(9), color: BLACK },
              paragraph: {
                indent: { left: 320, hanging: 240 },
              },
            },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: 11907, height: 16840 }, // A4 in twips
          margin: { top: 620, bottom: 620, left: 720, right: 720 },
        },
      },
      children: [
        nameParagraph,
        titleParagraph,
        contactParagraph,
        ...summarySection,
        ...skillsSection,
        ...experienceSection,
        ...projectsSection,
        ...educationSection,
        ...certificationsSection,
      ],
    },
  ],
});

const buffer = await Packer.toBuffer(doc);
writeFileSync(outPath, buffer);
console.log(`Wrote ${outPath}`);
