#!/usr/bin/env node
/** Deterministic 4:3 literature-report builder. Local files only, no model calls.
 * Requires @oai/artifact-tool from the runtime returned by load_workspace_dependencies.
 * A draft is not a final deliverable: use the presentations skill finalizer and visual QA.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PX_PER_PT = 4 / 3;
const SIZE = { width: 960, height: 720 };
const FONT = { zh: '楷体', latin: 'Times New Roman' };
const COLORS = { red: '#FF0000', blue: '#0000FF', summary: '#0070C0', black: '#000000', yellow: '#FFFF00' };
const TYPES = ['cover', 'intro', 'rationale', 'explainer', 'comparison', 'roadmap', 'question', 'answer', 'figure-right', 'figure-bottom', 'summary'];
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const rect = (left, top, width, height) => ({ left, top, width, height });
const fail = message => { throw new Error(message); };

function argsFrom(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--help', '--render', '--no-render'].includes(key)) out[key.slice(2)] = true;
    else if (['--plan', '--out-dir', '--template', '--node-modules', '--render-slides'].includes(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail(`Missing value for ${key}`);
      out[key.slice(2)] = argv[++i];
    } else fail(`Unknown option: ${key}`);
  }
  return out;
}

function paragraphs(value, label = 'text') {
  if (value === undefined || value === null || value === '') return [];
  const inputs = Array.isArray(value) ? value : [value];
  const result = [];
  for (const input of inputs) {
    if (typeof input === 'string') {
      for (const line of input.split('\n')) result.push({ runs: [{ text: line }] });
    } else if (input && typeof input === 'object') {
      const runs = input.runs || (typeof input.text === 'string' ? [input] : null);
      if (!Array.isArray(runs)) fail(`${label}: paragraph needs text or runs`);
      const clean = runs.map(r => typeof r === 'string' ? { text: r } : r);
      for (const r of clean) {
        if (!r || typeof r.text !== 'string' || /[\r\n]/.test(r.text)) fail(`${label}: each run must contain one text string without newlines`);
        if (r.color && !/^#[0-9a-f]{6}$/i.test(r.color)) fail(`${label}: color must be #RRGGBB`);
      }
      result.push({ runs: clean });
    } else fail(`${label}: expected string or paragraph object`);
  }
  return result;
}

function plain(value) { return paragraphs(value).map(p => p.runs.map(r => r.text).join('')).join('\n'); }
function required(value, label) { if (!plain(value).trim()) fail(`${label} is required`); }

function fontRuns(run, pt, color, bold) {
  // The source uses independent Latin and East Asian faces. Explicit runs avoid
  // relying on a theme whose default East Asian face is unrelated to the template.
  const parts = run.text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]+/gu) || [''];
  return parts.map(text => ({
    run: text,
    textStyle: {
      typeface: /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u.test(text) ? FONT.zh : FONT.latin,
      fontSize: `${pt}pt`, color: run.color || color,
      bold: run.bold ?? bold, italic: run.italic ?? false,
    },
    _highlight: run.highlight === true,
  }));
}

function estimatedLines(text, width, px) {
  // Conservative preflight only. The rendered layout is also inspected below.
  let lines = 1, x = 0;
  for (const c of text) {
    const w = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u.test(c) ? px : /[MW@#%]/.test(c) ? px * 0.9 : /[il.,' :;]/.test(c) ? px * 0.3 : px * 0.57;
    if (x + w > width && x > 0) { lines++; x = 0; }
    x += w;
  }
  return lines;
}

function textSlot(slide, name, value, frame, opts = {}, tracking) {
  const paras = paragraphs(value, name);
  if (!paras.length) return null;
  const pt = opts.pt ?? 18, px = pt * PX_PER_PT;
  const lineSpacing = opts.lineSpacing ?? 1.1;
  const contentWidth = frame.width - 4;
  const lineCount = paras.reduce((n, p) => n + estimatedLines(p.runs.map(r => r.text).join(''), contentWidth, px), 0);
  const estimatedHeight = lineCount * px * lineSpacing;
  if (estimatedHeight > frame.height - 2) fail(`${name}: text needs approximately ${Math.ceil(estimatedHeight)}px but slot has ${frame.height}px at ${pt}pt. Shorten or split the slide; font size is not silently reduced.`);
  const shape = slide.shapes.add({ geometry: 'textbox', name, position: frame, fill: 'none', line: { fill: 'none', width: 0 } });
  const mapped = paras.map(p => p.runs.flatMap(r => fontRuns(r, pt, opts.color || COLORS.black, opts.bold ?? false)));
  shape.text.style = {
    typeface: FONT.zh, fontSize: px, color: opts.color || COLORS.black, bold: opts.bold ?? false,
    alignment: opts.align || 'left', verticalAlignment: opts.valign || 'top',
    lineSpacing, wrap: 'square', autoFit: 'none', insets: { left: 2, right: 2, top: 0, bottom: 0 },
  };
  // Set defaults first: the grouped style setter also updates existing runs.
  // Assigning structured runs afterward preserves mixed fonts and local colors.
  shape.text = mapped.map(runs => ({ runs: runs.map(({ _highlight, ...run }) => run) }));
  shape.text.lineSpacing = lineSpacing;
  tracking.push({ name, frame, pt, lines: lineCount, highlight: mapped.map(runs => runs.map(r => r._highlight)) });
  return shape;
}

async function embed(slide, value, frame, name, planDir, assetRecords) {
  if (!value) fail(`${name}: figurePath is required; extract a real figure from the supplied paper`);
  const figure = typeof value === 'string' ? { path: value } : value;
  if (!figure.path || /^(?:https?|data|file):/i.test(figure.path)) fail(`${name}: image must be a local file path`);
  if (figure.crop) fail(`${name}: pre-crop the required evidence panels to a separate file so cropping is reviewable`);
  const imagePath = path.resolve(planDir, figure.path);
  const bytes = await fs.readFile(imagePath).catch(() => fail(`${name}: image does not exist: ${imagePath}`));
  const ext = path.extname(imagePath).toLowerCase();
  const type = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[ext];
  if (!type) fail(`${name}: use PNG, JPEG or WebP evidence image`);
  slide.images.add({ blob: bytes, contentType: type, alt: figure.alt || name, position: frame, fit: 'contain' });
  assetRecords.push({ name, path: imagePath, sha256: hash(bytes), bytes: bytes.length });
}

function sanitizedTemplate(imported) {
  const proto = imported.toProto();
  const first = proto.slides?.[0];
  if (!first || first.widthEmu !== 9144000 || first.heightEmu !== 6858000) fail('Template must use the verified 4:3 canvas (9144000 × 6858000 EMU)');
  // Preserve theme, masters, layout geometry and styles, but retain no scientific
  // material, images, original dates, fields, speaker notes or review metadata.
  proto.slides = [];
  proto.images = [];
  proto.charts = [];
  proto.contentReferences = [];
  proto.people = [];
  proto.threads = [];
  function scrub(element) {
    element.paragraphs = [];
    element.citations = [];
    element.reviewMarkIds = [];
    delete element.table; delete element.chart; delete element.image; delete element.media;
    if (element.children) element.children = element.children.filter(e => e.placeholderType).map(scrub);
    return element;
  }
  for (const layout of proto.layouts || []) {
    // All reference master/layout items are placeholders. Restricting this to
    // placeholders also rejects scientific text/images hidden in other templates.
    layout.elements = (layout.elements || []).filter(e => e.placeholderType).map(scrub);
    layout.background = undefined;
    layout.furnitureVisibility = { dateTime: false, footer: false, slideNumber: false, header: false };
  }
  return proto;
}

function validatePlan(plan) {
  if (plan.version !== 1) fail('plan.version must be 1');
  if (!Array.isArray(plan.slides) || !plan.slides.length || plan.slides.length > 100) fail('plan.slides must contain 1–100 slides');
  required(plan.paper?.title, 'paper.title');
  required(plan.paper?.citation, 'paper.citation');
  plan.slides.forEach((s, i) => {
    const label = `slide ${i + 1}`;
    if (!TYPES.includes(s.type)) fail(`${label}: unknown type ${s.type}`);
    const titleOptional = s.type === 'cover' || s.type === 'comparison' || (s.type === 'explainer' && s.figurePath && s.imageIncludesTitle !== false);
    if (!titleOptional) required(s.title || (s.type === 'question' || s.type === 'answer' ? `科学问题${s.number || ''}` : ''), `${label}.title`);
    if (['question', 'answer'].includes(s.type)) required(s.question || s.body, `${label}.question`);
    if (s.type === 'answer') required(s.answer, `${label}.answer`);
    if (s.type.startsWith('figure-')) {
      required(s.caption || s.body, `${label}.caption`);
      required(s.source, `${label}.source (figure number/panels/page)`);
      if (s.captionPt !== undefined && (typeof s.captionPt !== 'number' || s.captionPt < 11 || s.captionPt > 18)) fail(`${label}.captionPt must be 11–18 pt`);
      if (s.annotationPt !== undefined && (typeof s.annotationPt !== 'number' || s.annotationPt < 12 || s.annotationPt > 14)) fail(`${label}.annotationPt must be 12–14 pt`);
    }
    if (s.type === 'rationale') {
      if (s.figurePath) {
        required(s.source, `${label}.source`);
        if (plain(s.body).trim() || plain(s.focus).trim()) fail(`${label}: image rationale uses title + figurePath; put detailed body/focus on a separate slide or in notes`);
      } else { required(s.body, `${label}.body`); required(s.focus, `${label}.focus`); }
    }
    if (s.type === 'explainer') {
      required(s.source, `${label}.source`);
      if (s.imageIncludesTitle !== undefined && typeof s.imageIncludesTitle !== 'boolean') fail(`${label}.imageIncludesTitle must be boolean`);
      if (s.figurePath && plain(s.body).trim()) fail(`${label}: an image explainer uses only the image and optional title; use notes for extra explanation`);
      if (!s.figurePath) required(s.body, `${label}.body`);
    }
    if (s.type === 'comparison') {
      required(s.source, `${label}.source`);
      if (!Array.isArray(s.columns) || s.columns.length < 2 || s.columns.length > 6 || s.columns.some(v => typeof v !== 'string' || !v.trim())) fail(`${label}.columns needs 2–6 nonempty column names`);
      if (!Array.isArray(s.rows) || !s.rows.length || s.rows.length > 10 || s.rows.some(row => !Array.isArray(row) || row.length !== s.columns.length || row.some(v => !['string', 'number'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))))) fail(`${label}.rows needs 1–10 rows matching columns, with string or finite number values`);
      if (s.columnWidths !== undefined && (!Array.isArray(s.columnWidths) || s.columnWidths.length !== s.columns.length || s.columnWidths.some(v => typeof v !== 'number' || !Number.isFinite(v) || v <= 0))) fail(`${label}.columnWidths needs one positive relative width per column`);
      if (s.tablePt !== undefined && (typeof s.tablePt !== 'number' || s.tablePt < 14 || s.tablePt > 18)) fail(`${label}.tablePt must be 14–18 pt`);
      if (s.highlightRows !== undefined && (!Array.isArray(s.highlightRows) || s.highlightRows.length > Math.min(3, s.rows.length) || new Set(s.highlightRows).size !== s.highlightRows.length || s.highlightRows.some(v => !Number.isInteger(v) || v < 1 || v > s.rows.length))) fail(`${label}.highlightRows allows at most 3 unique data row numbers, starting at 1`);
    }
    if (s.type === 'roadmap' && (!Array.isArray(s.steps) || s.steps.length < 2 || s.steps.length > 5)) fail(`${label}.steps needs 2–5 {text,question} entries`);
    if (s.type === 'summary' && (!Array.isArray(s.sections) || s.sections.length < 1 || s.sections.length > 3)) fail(`${label}.sections needs 1–3 {title,body} entries`);
  });
}

async function addSlide(presentation, spec, index, plan, planDir, layoutId) {
  const slide = presentation.slides.add({ width: SIZE.width, height: SIZE.height, layoutId });
  slide.background.fill = '#FFFFFF';
  const tracking = [], assets = [];
  const prefix = `s${String(index + 1).padStart(2, '0')}`;
  const t = (name, value, box, opts) => textSlot(slide, `${prefix}.${name}`, value, box, opts, tracking);
  const img = (value, box, name = 'figure') => embed(slide, value, box, `${prefix}.${name}`, planDir, assets);
  const title = spec.title || plan.paper.title;
  if (spec.type === 'cover') {
    const titleLines = paragraphs(title).reduce((n, p) => n + estimatedLines(p.runs.map(r => r.text).join(''), 896, 28 * PX_PER_PT), 0);
    // Paragraph baselines may sit farther apart than the plain-text estimate
    // after a PPTX import. Reserve extra height before placing the header image.
    const titleHeight = titleLines * 28 * PX_PER_PT * 1.35;
    const headerY = Math.max(120.42, 26 + titleHeight + 16);
    if (487.8 - headerY < 220) fail(`${prefix}.title: cover title leaves too little room for the paper header; use a shorter faithful Chinese title`);
    t('title', title, rect(30, 26, 900, Math.max(94, Math.ceil(titleHeight + 4))), { pt: 28, color: COLORS.red, bold: true });
    if (spec.figurePath) await img(spec.figurePath, rect(0, headerY, 960, 487.8 - headerY), 'paper-header');
    else t('paper-header-text', spec.originalTitle || plan.paper.originalTitle || plan.paper.citation, rect(18, Math.max(228, headerY), 920, 270), { pt: 24, bold: true });
    const presenter = spec.presenter ?? plan.presenter;
    const date = spec.date ?? plan.date;
    t('presenter', [presenter ? `汇报人：${presenter}` : '', date || ''].filter(Boolean).join('\n'), rect(712, 645, 224, 67), { pt: 18 });
  } else if (spec.type === 'intro') {
    t('title', title, rect(30, 18, 900, 80), { pt: 36, color: COLORS.blue, bold: true });
    if (spec.figurePath) {
      await img(spec.figurePath, rect(48, 158, 250, 380));
      t('body', spec.body, rect(328, 170, 584, 434), { pt: 18 });
    } else t('body', spec.body, rect(40, 148, 872, 485), { pt: 20 });
  } else if (spec.type === 'rationale') {
    t('title', [{ text: title, highlight: true }], rect(10, 10, 910, 42), { pt: 20 });
    if (spec.figurePath) await img(spec.figurePath, rect(12, 64, 936, 636));
    else {
      t('body', spec.body, rect(12, 164, 924, 270), { pt: 18 });
      t('focus', plain(spec.focus).split('\n').map(text => ({ text, highlight: true })), rect(12, 454, 924, 234), { pt: 28, color: COLORS.red });
    }
  } else if (spec.type === 'explainer') {
    if (spec.figurePath) {
      if (spec.imageIncludesTitle === false) {
        t('title', title, rect(24, 18, 912, 74), { pt: 24, color: COLORS.blue, bold: true });
        await img(spec.figurePath, rect(8, 102, 944, 610));
      } else await img(spec.figurePath, rect(0, 0, 960, 720));
    } else {
      t('title', title, rect(24, 18, 912, 74), { pt: 24, color: COLORS.blue, bold: true });
      t('body', spec.body, rect(40, 150, 880, 510), { pt: 22, lineSpacing: 1.2 });
    }
  } else if (spec.type === 'comparison') {
    if (spec.title) t('title', spec.title, rect(24, 18, 912, 74), { pt: 24, color: COLORS.blue, bold: true });
    const pt = spec.tablePt ?? 16, px = pt * PX_PER_PT;
    const values = [spec.columns, ...spec.rows].map(row => row.map(String));
    const weights = spec.columnWidths || spec.columns.map(() => 1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map(v => v / totalWeight * 912);
    const heights = values.map(row => Math.max(50, ...row.map((value, c) => value.split('\n').reduce((n, line) => n + estimatedLines(line, widths[c] - 20, px), 0) * px * 1.12 + 20)));
    const tableTop = spec.title ? 110 : 28;
    const height = heights.reduce((a, b) => a + b, 0);
    if (height > 692 - tableTop) fail(`${prefix}.comparison: table needs ${Math.ceil(height)}px but only ${692 - tableTop}px are available. Shorten cells, change columnWidths, or split into more slides.`);
    const table = slide.tables.add({ rows: values.length, columns: spec.columns.length, left: 24, top: tableTop, width: 912, height, columnWidths: widths, values });
    table.styleOptions = { headerRow: false, bandedRows: false, firstColumn: false };
    table.borders.assign({ style: 'solid', fill: '#C6CDD6', width: 1 });
    const highlighted = new Set(spec.highlightRows || []);
    for (let r = 0; r < values.length; r++) {
      table.rows[r].height = heights[r];
      table.cells.block({ row: r, column: 0, rowCount: 1, columnCount: spec.columns.length }).assign({
        fill: r === 0 ? '#DFE7F0' : highlighted.has(r) ? '#FFF2CC' : r % 2 ? '#FFFFFF' : '#F3F4F6',
        margins: { left: 10, right: 10, top: 8, bottom: 8 }, anchor: 'center',
      });
      for (let c = 0; c < spec.columns.length; c++) {
        const cell = table.getCell(r, c);
        cell.text.style = { typeface: FONT.zh, fontSize: px, color: COLORS.black, bold: r === 0, alignment: 'left', wrap: 'square', autoFit: 'none', lineSpacing: 1.12 };
        cell.value = values[r][c].split('\n').map(text => ({ runs: fontRuns({ text }, pt, COLORS.black, r === 0).map(({ _highlight, ...run }) => run) }));
      }
    }
    tracking.push({ name: `${prefix}.comparison-table`, frame: rect(24, tableTop, 912, height), pt, rows: values.length, columns: spec.columns.length, highlight: [] });
  } else if (spec.type === 'question' || spec.type === 'answer') {
    const label = spec.title || `科学问题${spec.number || ''}`;
    const question = spec.question || spec.body;
    t('question-label', label, rect(30, spec.type === 'answer' ? 188 : 252, 900, 48), { pt: 28, color: COLORS.red, bold: true, align: 'center' });
    t('question', question, rect(28, spec.type === 'answer' ? 238 : 302, 902, 154), { pt: 28, bold: true, align: 'center' });
    if (spec.type === 'answer') {
      t('answer-label', '回答：', rect(42, 414, 866, 48), { pt: 28, color: COLORS.red, bold: true, align: 'center' });
      t('answer', spec.answer, rect(58, 466, 844, 214), { pt: 28, bold: true, align: 'center' });
    }
  } else if (spec.type === 'figure-right') {
    t('title', title, rect(18, 10, 912, 60), { pt: 18 });
    await img(spec.figurePath, rect(12, 80, 648, spec.annotation ? 554 : 626));
    if (spec.annotation) t('annotation', spec.annotation, rect(12, 642, 648, 64), { pt: spec.annotationPt ?? 12, color: COLORS.red });
    t('caption', spec.caption || spec.body, rect(682, 82, 266, 616), { pt: spec.captionPt ?? 15 });
  } else if (spec.type === 'figure-bottom') {
    t('title', title, rect(18, 10, 914, 60), { pt: 18 });
    await img(spec.figurePath, rect(8, 78, 944, spec.annotation ? 322 : 398));
    if (spec.annotation) t('annotation', spec.annotation, rect(20, 411, 912, 65), { pt: spec.annotationPt ?? 12, color: COLORS.red });
    t('caption', spec.caption || spec.body, rect(20, 494, 912, 206), { pt: spec.captionPt ?? 16 });
  } else if (spec.type === 'roadmap') {
    t('title', title, rect(22, 20, 914, 52), { pt: 24, color: COLORS.red });
    const count = spec.steps.length, rowH = 602 / count, nodes = [];
    for (let j = 0; j < count; j++) {
      const step = spec.steps[j];
      required(step.text, `${prefix}.steps[${j}].text`);
      const y = 90 + j * rowH;
      const node = t(`step-${j + 1}`, step.text, rect(24, y, 528, rowH - 32), { pt: 16.5, bold: true, align: 'center', valign: 'middle' });
      nodes.push(node);
      if (step.question) {
        const questionBody = plain(step.question);
        const questionLines = 1 + questionBody.split('\n').reduce((n, line) => n + estimatedLines(line, 350, 14 * PX_PER_PT), 0);
        const questionHeight = Math.max(50, Math.ceil(questionLines * 14 * PX_PER_PT * 1.35 + 12));
        if (questionHeight > rowH - 20) fail(`${prefix}.steps[${j}].question: question would cross the next roadmap row. Shorten it or use fewer steps.`);
        const question = t(`step-question-${j + 1}`, [{ text: `科学问题${j + 1}：`, color: COLORS.red, bold: true }, ...questionBody.split('\n').map(text => ({ text, bold: true }))], rect(584, y, 354, questionHeight), { pt: 14 });
        question.line = { fill: COLORS.red, width: 1 };
      }
    }
    for (let j = 0; j < nodes.length - 1; j++) slide.shapes.connect(nodes[j], nodes[j + 1], { kind: 'straight', fromSide: 'bottom', toSide: 'top', line: { fill: '#4472C4', width: 3 }, tail: { type: 'triangle', width: 'med', length: 'med' } });
  } else if (spec.type === 'summary') {
    const count = spec.sections.length, rowH = 624 / count;
    for (let j = 0; j < count; j++) {
      const section = spec.sections[j];
      required(section.title, `${prefix}.sections[${j}].title`);
      required(section.body, `${prefix}.sections[${j}].body`);
      t(`section-${j + 1}-title`, section.title, rect(48, 56 + j * rowH, 874, 42), { pt: 18, color: COLORS.summary, bold: j === 0 });
      t(`section-${j + 1}-body`, section.body, rect(48, 102 + j * rowH, 874, rowH - 54), { pt: 18 });
    }
  }
  // A notes field belongs only to this newly generated slide. No old notes survive.
  const sources = Array.isArray(spec.source) ? spec.source : [spec.source || plan.paper.citation];
  const notes = [spec.notes || '', ...sources.map(s => `来源：${s}`)].filter(Boolean).join('\n\n');
  slide.speakerNotes.textFrame.setText(notes);
  return { slide, type: spec.type, tracking, assets, notes };
}

function applyHighlights(presentation, records, Presentation) {
  // Highlight is serialized by Artifact Tool as a native OOXML run property.
  // The public rich-text facade omits this property; use its public toProto/load
  // adapter and the same highlight structure observed in the imported template.
  const proto = presentation.toProto();
  for (let i = 0; i < records.length; i++) {
    const map = new Map(records[i].tracking.map(t => [t.name, t]));
    for (const element of proto.slides[i].elements) {
      const info = map.get(element.name);
      if (!info) continue;
      (element.paragraphs || []).forEach((p, pi) => (p.runs || []).forEach((r, ri) => {
        if (info.highlight[pi]?.[ri]) { r.textStyle ||= {}; r.textStyle.highlight = { type: 1, value: 'FFFF00' }; }
      }));
    }
  }
  return Presentation.load(proto);
}

export async function buildDeck(options) {
  if (!options.plan || !options['out-dir']) fail('Use --plan <json> --out-dir <private-build-dir>');
  const planPath = path.resolve(options.plan), outDir = path.resolve(options['out-dir']);
  const planDir = path.dirname(planPath);
  const plan = JSON.parse((await fs.readFile(planPath, 'utf8')).replace(/^\uFEFF/, ''));
  validatePlan(plan);
  const templatePath = path.resolve(options.template || path.join(SCRIPT_DIR, '../assets/reference.pptx'));
  if ([planPath, templatePath].includes(path.join(outDir, 'draft.pptx'))) fail('Build output must not overwrite the source template or plan');
  const nodeModules = options['node-modules'] || process.env.RUNTIME_NODE_MODULES;
  const require = createRequire(nodeModules ? path.join(path.resolve(nodeModules), '.codex-runtime.cjs') : import.meta.url);
  const { Presentation, PresentationFile, FileBlob } = await import(pathToFileURL(require.resolve('@oai/artifact-tool')).href);
  const templateBytes = await fs.readFile(templatePath);
  const imported = await PresentationFile.importPptx(await FileBlob.load(templatePath));
  const sourceSnapshot = await imported.inspect({ kind: 'layout', maxChars: 8000 });
  const proto = sanitizedTemplate(imported);
  let presentation = Presentation.load(proto);
  const blankLayout = presentation.layouts.items.find(l => l.id === proto.layouts.find(x => x.type === 'blank')?.id);
  if (!blankLayout) fail('Reference template has no blank layout');
  const records = [];
  for (let i = 0; i < plan.slides.length; i++) records.push(await addSlide(presentation, plan.slides[i], i, plan, planDir, blankLayout.id));
  presentation = applyHighlights(presentation, records, Presentation);
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(path.join(outDir, 'renders'), { recursive: true });
  await fs.mkdir(path.join(outDir, 'layouts'), { recursive: true });
  const draftPath = path.join(outDir, 'draft.pptx');
  await (await PresentationFile.exportPptx(presentation)).save(draftPath);
  await fs.writeFile(path.join(outDir, 'template-layouts.ndjson'), sourceSnapshot.ndjson);
  let selected = null;
  if (options['render-slides']) {
    selected = new Set(options['render-slides'].split(',').map(Number));
    if ([...selected].some(n => !Number.isInteger(n) || n < 1 || n > records.length)) fail('--render-slides contains an invalid slide number');
  }
  const shouldRender = !options['no-render'];
  const manifest = {
    version: 1, status: 'draft-requires-finalization-and-visual-review', mode: plan.mode || 'paper-report',
    draftPath, planPath, templatePath, templateSha256: hash(templateBytes), slideSize: SIZE,
    expectedSlideSizeEmu: '9144000,6858000', slideCount: records.length,
    fontPolicy: { basis: 'reference', families: [FONT.zh, FONT.latin], referencePath: templatePath, referenceSha256: hash(templateBytes) },
    slides: [],
  };
  for (let i = 0; i < records.length; i++) {
    const slide = presentation.slides.items[i], record = records[i];
    const layoutPath = path.join(outDir, 'layouts', `slide-${i + 1}.json`);
    const layout = await slide.export({ format: 'layout' });
    await fs.writeFile(layoutPath, await layout.text());
    let previewPath = null;
    if (shouldRender && (!selected || selected.has(i + 1))) {
      previewPath = path.join(outDir, 'renders', `slide-${i + 1}.png`);
      const preview = await presentation.export({ slide, format: 'png', scale: 1 });
      await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
    }
    manifest.slides.push({ number: i + 1, type: record.type, layoutPath, previewPath, slots: record.tracking.map(({highlight,...t}) => t), assets: record.assets });
    console.log(`Slide ${i + 1}/${records.length}: ${record.type}${previewPath ? ' rendered' : ''}`);
  }
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Draft: ${draftPath}`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = argsFrom(process.argv.slice(2));
    if (options.help) console.log('node build_deck.mjs --plan plan.json --out-dir work/build [--template assets/reference.pptx] [--node-modules PATH] [--no-render | --render-slides 2,5]\nDefault: render every slide. Output is a private draft, not a checked final PPTX.');
    else await buildDeck(options);
  } catch (error) { console.error(`BUILD ERROR: ${error.message}`); process.exitCode = 1; }
}
