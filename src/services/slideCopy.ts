import type { slides_v1 } from 'googleapis';

type Presentation = slides_v1.Schema$Presentation;
type Page = slides_v1.Schema$Page;
type PageElement = slides_v1.Schema$PageElement;
type Request = slides_v1.Schema$Request;
type Transform = slides_v1.Schema$AffineTransform;
type TextContent = slides_v1.Schema$TextContent;

/**
 * How a copied slide looks in another deck: `source` keeps its look (styles, colours, background and the template's
 * decorations are copied onto the slide), `destination` takes the other deck's template (same-named layout, text in its
 * placeholders).
 */
export type SlideDesign = 'source' | 'destination';

export interface SlideCopyPlan {
  /** The new slide's id. */
  slideId: string,
  /** Requests that create the slide and everything on it. */
  requests: Request[],
  /** The source slide's speaker notes, set once the slide exists (its notes shape id isn't known before). */
  notes: string,
  /** The layout used in the other deck. */
  layout: string,
  /** Placeholders kept as placeholders of the other deck's layout (otherwise everything is a plain element). */
  placeholders: boolean,
  /** Elements that couldn't be copied, e.g. "word art". */
  skipped: string[],
}

const EMU_PER_PT = 12700;
const TEXT_STYLE_FIELDS = ['bold', 'italic', 'underline', 'strikethrough', 'smallCaps', 'baselineOffset', 'fontSize', 'foregroundColor', 'backgroundColor', 'link', 'weightedFontFamily', 'fontFamily'] as const;
const PARAGRAPH_STYLE_FIELDS = ['alignment', 'lineSpacing', 'indentStart', 'indentEnd', 'indentFirstLine', 'spaceAbove', 'spaceBelow', 'direction', 'spacingMode'] as const;

/** Every page element, groups included, by id. */
function elementsById(pages: Page[]): Map<string, PageElement> {
  const map = new Map<string, PageElement>();
  const add = (list?: PageElement[] | null) => (list ?? []).forEach(e => {
    map.set(e.objectId!, e);
    add(e.elementGroup?.children);
  });
  pages.forEach(p => add(p.pageElements));
  return map;
}

/** Deep merge of style objects, later ones winning (empty objects such as `backgroundColor: {}` count as unset). */
function merge<T extends object>(...styles: (T | null | undefined)[]): T {
  const out: any = {};
  for (const style of styles) {
    for (const [k, v] of Object.entries(style ?? {})) {
      if (v == null) continue;
      if (typeof v == 'object' && !Array.isArray(v)) {
        if (Object.keys(v).length == 0) continue;
        out[k] = k.endsWith('Color') || k == 'weightedFontFamily' || k == 'link' ? v : merge(out[k], v);
      }
      else out[k] = v;
    }
  }
  return out;
}

/** Theme colours (ACCENT1...) replaced by the RGB colour they have in the source deck, which may differ in the other deck. */
function withRgb<T>(value: T, scheme: Map<string, slides_v1.Schema$RgbColor>): T {
  if (Array.isArray(value)) return value.map(v => withRgb(v, scheme)) as any;
  if (!value || typeof value != 'object') return value;
  const out: any = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = k == 'themeColor' ? undefined : withRgb(v, scheme);
  }
  if ((value as any).themeColor) {
    delete out.themeColor;
    out.rgbColor = scheme.get((value as any).themeColor) ?? {};
  }
  return out;
}

/** `outer` applied after `inner` (a child's transform inside a group, made absolute). */
function compose(outer: Transform, inner: Transform): Transform {
  const emu = (t: Transform) => t.unit == 'PT' ? EMU_PER_PT : 1;
  const [a1, b1, c1, d1, x1, y1] = [outer.scaleX ?? 1, outer.shearY ?? 0, outer.shearX ?? 0, outer.scaleY ?? 1, (outer.translateX ?? 0) * emu(outer), (outer.translateY ?? 0) * emu(outer)];
  const [a2, b2, c2, d2, x2, y2] = [inner.scaleX ?? 1, inner.shearY ?? 0, inner.shearX ?? 0, inner.scaleY ?? 1, (inner.translateX ?? 0) * emu(inner), (inner.translateY ?? 0) * emu(inner)];
  return {
    scaleX: a1 * a2 + c1 * b2, shearY: b1 * a2 + d1 * b2,
    shearX: a1 * c2 + c1 * d2, scaleY: b1 * c2 + d1 * d2,
    translateX: a1 * x2 + c1 * y2 + x1, translateY: b1 * x2 + d1 * y2 + y1, unit: 'EMU',
  };
}

/** The slide's text as one string, with where each paragraph and run starts and ends. */
function textParts(text?: TextContent | null) {
  const paragraphs: { start: number, end: number, style?: slides_v1.Schema$ParagraphStyle, bullet?: slides_v1.Schema$Bullet }[] = [];
  const runs: { start: number, end: number, style?: slides_v1.Schema$TextStyle }[] = [];
  let full = '';
  for (const e of text?.textElements ?? []) {
    const start = e.startIndex ?? 0;
    if (e.paragraphMarker) paragraphs.push({ start, end: e.endIndex ?? start, style: e.paragraphMarker.style ?? undefined, bullet: e.paragraphMarker.bullet ?? undefined });
    const content = e.textRun?.content ?? e.autoText?.content;
    if (content != null) {
      full += content;
      runs.push({ start, end: e.endIndex ?? start + content.length, style: (e.textRun ?? e.autoText)?.style ?? undefined });
    }
  }
  return { full, paragraphs, runs };
}

/** The bullet preset closest to a list's glyph (the API can only create lists from presets). */
function bulletPreset(glyph?: string | null): string {
  if (glyph && /\d/.test(glyph)) return 'NUMBERED_DIGIT_ALPHA_ROMAN';
  if (glyph && /^[a-zA-Z]/.test(glyph)) return 'NUMBERED_UPPERALPHA_ALPHA_ROMAN';
  if (glyph == '☐' || glyph == '✓') return 'BULLET_CHECKBOX';
  if (glyph == '❖' || glyph == '➢') return 'BULLET_DIAMONDX_ARROW3D_SQUARE';
  return 'BULLET_DISC_CIRCLE_SQUARE';
}

function pick<T extends object>(style: T, fields: readonly string[]): { style: any, fields: string } {
  const out: any = {};
  for (const f of fields) if ((style as any)[f] != null) out[f] = (style as any)[f];
  // fontFamily and weightedFontFamily must agree, the weighted one carries the weight too
  if (out.weightedFontFamily) delete out.fontFamily;
  // Links to slides point at the other deck's pages, only web links survive the copy
  if (out.link && !out.link.url) delete out.link;
  return { style: out, fields: Object.keys(out).join(',') };
}

/**
 * Requests that write `text` into a shape or table cell (already created and empty), with its paragraph and text styles
 * and lists. `base` gives the styles a paragraph inherits (from the placeholders above it) at a list nesting level.
 */
function textRequests(objectId: string, text: TextContent | null | undefined, options: {
  cellLocation?: slides_v1.Schema$TableCellLocation,
  base?: (nesting: number) => { paragraph?: slides_v1.Schema$ParagraphStyle, run?: slides_v1.Schema$TextStyle },
  fontScale?: number,
  colours?: (v: any) => any,
} = {}): Request[] {
  const { full, paragraphs, runs } = textParts(text);
  // Every shape's text ends with a newline the API adds itself
  const length = full.endsWith('\n') ? full.length - 1 : full.length;
  if (length <= 0) return [];
  const colours = options.colours ?? ((v: any) => v);
  const at = options.cellLocation ? { cellLocation: options.cellLocation } : {};
  const nestingAt = (index: number) => paragraphs.find(p => p.start <= index && index < p.end)?.bullet?.nestingLevel ?? 0;

  // Lists are created from tabs at the start of each paragraph (one per nesting level), which the API then removes,
  // so the text goes in with tabs and the list requests run from the end backwards
  let tabbed = '';
  const tabbedStart: number[] = [];
  let shift = 0;
  for (const p of paragraphs) {
    tabbedStart.push(p.start + shift);
    const tabs = p.bullet ? '\t'.repeat(p.bullet.nestingLevel ?? 0) : '';
    tabbed += tabs + full.slice(p.start, p.end);
    shift += tabs.length;
  }
  if (!paragraphs.length) tabbed = full;
  const tabbedLength = tabbed.endsWith('\n') ? tabbed.length - 1 : tabbed.length;
  const requests: Request[] = [{ insertText: { objectId, ...at, insertionIndex: 0, text: tabbed.slice(0, tabbedLength) } }];

  const groups: { from: number, to: number, preset: string }[] = [];
  paragraphs.forEach((p, i) => {
    if (!p.bullet) return;
    const preset = bulletPreset(p.bullet.glyph);
    const last = groups[groups.length - 1];
    if (last && last.to == i - 1 && last.preset == preset) last.to = i;
    else groups.push({ from: i, to: i, preset });
  });
  for (const g of groups.reverse()) {
    const start = tabbedStart[g.from];
    const end = Math.min(g.to + 1 < paragraphs.length ? tabbedStart[g.to + 1] : tabbedLength, tabbedLength);
    requests.push({ createParagraphBullets: { objectId, ...at, textRange: end > start ? { type: 'FIXED_RANGE', startIndex: start, endIndex: end } : { type: 'FROM_START_INDEX', startIndex: start }, bulletPreset: g.preset } });
  }

  for (const p of paragraphs) {
    const resolved = colours(merge(options.base?.(p.bullet?.nestingLevel ?? 0).paragraph, p.style));
    // A list's indents come with its preset
    if (p.bullet) { delete resolved.indentStart; delete resolved.indentFirstLine; }
    const { style, fields } = pick(resolved, PARAGRAPH_STYLE_FIELDS);
    if (!fields || p.start >= length) continue;
    const end = Math.min(p.end, length);
    requests.push({ updateParagraphStyle: { objectId, ...at, textRange: end > p.start ? { type: 'FIXED_RANGE', startIndex: p.start, endIndex: end } : { type: 'FROM_START_INDEX', startIndex: p.start }, style, fields } });
  }
  for (const r of runs) {
    const end = Math.min(r.end, length);
    if (r.start >= end) continue;
    const resolved: any = colours(merge(options.base?.(nestingAt(r.start)).run, r.style));
    // Shrink-on-overflow text is drawn smaller than its font size, and a copy has no autofit
    if (resolved.fontSize?.magnitude && options.fontScale && options.fontScale < 1) {
      resolved.fontSize = { ...resolved.fontSize, magnitude: Math.round(resolved.fontSize.magnitude * options.fontScale * 10) / 10 };
    }
    const { style, fields } = pick(resolved, TEXT_STYLE_FIELDS);
    if (fields) requests.push({ updateTextStyle: { objectId, ...at, textRange: { type: 'FIXED_RANGE', startIndex: r.start, endIndex: end }, style, fields } });
  }
  return requests;
}

/** Fill and outline as update requests: what's drawn, or NOT_RENDERED so the new element's defaults don't show. */
function fill(f: slides_v1.Schema$ShapeBackgroundFill | null | undefined) {
  return !f || f.propertyState == 'NOT_RENDERED' || !f.solidFill ? { propertyState: 'NOT_RENDERED' } : { solidFill: f.solidFill };
}
function outline(o: slides_v1.Schema$Outline | null | undefined) {
  if (!o || o.propertyState == 'NOT_RENDERED') return { propertyState: 'NOT_RENDERED' };
  return merge<slides_v1.Schema$Outline>({ outlineFill: o.outlineFill, weight: o.weight, dashStyle: o.dashStyle });
}

/** The page size ratio between decks, so a slide copied into a 4:3 deck still fits. */
function scaler(source: Presentation, target: Presentation) {
  const w = (p: Presentation) => p.pageSize?.width?.magnitude ?? 9144000;
  const h = (p: Presentation) => p.pageSize?.height?.magnitude ?? 5143500;
  const rx = w(target) / w(source);
  const ry = h(target) / h(source);
  if (Math.abs(rx - 1) < 0.01 && Math.abs(ry - 1) < 0.01) return (t: Transform) => t;
  return (t: Transform) => {
    const emu = t.unit == 'PT' ? EMU_PER_PT : 1;
    return { ...t, scaleX: (t.scaleX ?? 1) * rx, shearX: (t.shearX ?? 0) * rx, translateX: (t.translateX ?? 0) * emu * rx, scaleY: (t.scaleY ?? 1) * ry, shearY: (t.shearY ?? 0) * ry, translateY: (t.translateY ?? 0) * emu * ry, unit: 'EMU' };
  };
}

/** Placeholders a layout has that `createSlide` doesn't put on the new slide. */
const NOT_CREATED = ['SLIDE_NUMBER', 'FOOTER', 'DATE_AND_TIME', 'HEADER', 'SLIDE_IMAGE'];

/** Placeholders on a slide with no text, left over from its layout ("Click to add text" boxes). */
export function emptyPlaceholders(slide?: Page): string[] {
  return (slide?.pageElements ?? []).filter(e => e.shape?.placeholder && !textParts(e.shape.text).full.trim()).map(e => e.objectId!);
}

const placeholderKind = (type?: string | null) => type == 'CENTERED_TITLE' ? 'TITLE' : type == 'SUBTITLE' ? 'BODY' : type ?? '';
const layoutName = (l?: Page) => (l?.layoutProperties?.displayName ?? l?.layoutProperties?.name ?? '').toLowerCase();

/**
 * Where to create a slide with `layout` so it ends up at `target` (0-based). A slide can only be inserted next to slides
 * using its layout's master (decks like the brand guide have several), so it's created after the last slide with that
 * master, then moved where it should go.
 */
export function slideCreateIndex(presentation: Presentation, layout: Page | undefined, target: number): number {
  const slides = presentation.slides ?? [];
  if (!layout) return target;
  const layoutMaster = new Map((presentation.layouts ?? []).map(l => [l.objectId, l.layoutProperties?.masterObjectId]));
  const master = layout.layoutProperties?.masterObjectId;
  const sameMaster = slides.map((s, i) => layoutMaster.get(s.slideProperties?.layoutObjectId ?? '') == master ? i : -1).filter(i => i >= 0);
  if (sameMaster.length && !sameMaster.some(i => i == target - 1 || i == target)) return sameMaster[sameMaster.length - 1] + 1;
  if (!sameMaster.length) return 0;
  return target;
}

/**
 * The `insertionIndex` that puts `moving` at `position` (1 = first) once moved. The API counts it in the order before the
 * move, so moving a slide down by `position - 1` landed it one place short (found 2026-10-25: slide 1 moved to 3 ended at 2).
 */
export function slideMoveIndex(order: string[], moving: string[], position: number): number {
  let staying = 0;
  for (let i = 0; i < order.length; i++) {
    if (moving.includes(order[i])) continue;
    if (staying == position - 1) return i;
    staying++;
  }
  return order.length;
}

/** The create (and move) requests for a new slide with `layout` at position `target` (0-based). */
export function createSlideRequests(presentation: Presentation, objectId: string, layout: { layoutId: string, page?: Page } | { predefinedLayout: string }, target: number, placeholderIdMappings?: slides_v1.Schema$LayoutPlaceholderIdMapping[]): Request[] {
  const page = 'layoutId' in layout ? layout.page : undefined;
  const createAt = slideCreateIndex(presentation, page, target);
  return [
    { createSlide: { objectId, insertionIndex: createAt, slideLayoutReference: 'layoutId' in layout ? { layoutId: layout.layoutId } : { predefinedLayout: layout.predefinedLayout }, ...(placeholderIdMappings?.length ? { placeholderIdMappings } : {}) } },
    ...(createAt != target ? [{ updateSlidesPosition: { slideObjectIds: [objectId], insertionIndex: target > createAt ? target + 1 : target } }] : []),
  ];
}

/**
 * Plans a copy of `slide` from the `source` deck into the `target` deck at `position` (0-based). The Slides API can't copy
 * slides between decks, so the slide is rebuilt: shapes, text with its styles and lists, images (from their temporary
 * content URLs), lines, tables, groups, videos and charts (as images). Placeholders inherit their look from the layout
 * and master, which the other deck doesn't have, so with design `source` that look is resolved and copied (as plain
 * elements), unless the other deck uses the same template.
 */
export function planSlideCopy(source: Presentation, slide: Page, target: Presentation, position: number, design: SlideDesign, newId: (prefix: string) => string): SlideCopyPlan {
  const sourceLayout = source.layouts?.find(l => l.objectId == slide.slideProperties?.layoutObjectId);
  const sourceMaster = source.masters?.find(m => m.objectId == (slide.slideProperties?.masterObjectId ?? sourceLayout?.layoutProperties?.masterObjectId));
  const scheme = new Map((sourceMaster?.pageProperties?.colorScheme?.colors ?? []).map(c => [c.type!, c.color ?? {}]));
  const inherited = elementsById([...(source.layouts ?? []), ...(source.masters ?? [])]);
  const masterName = (p: Presentation, l?: Page) => (p.masters?.find(m => m.objectId == l?.layoutProperties?.masterObjectId)?.masterProperties?.displayName ?? '').toLowerCase();

  const named = (target.layouts ?? []).filter(l => sourceLayout && layoutName(l) == layoutName(sourceLayout));
  const sameTemplate = named.find(l => masterName(target, l) == masterName(source, sourceLayout));
  const blank = (target.layouts ?? []).find(l => l.layoutProperties?.name == 'BLANK' || layoutName(l) == 'blank')
    ?? [...(target.layouts ?? [])].sort((a, b) => (a.pageElements?.length ?? 0) - (b.pageElements?.length ?? 0))[0];
  // Placeholders are kept when the other deck's layout gives them the same look, or the copy should take its look
  const usePlaceholders = !!sameTemplate || design == 'destination';
  const layout = sameTemplate ?? (design == 'destination' ? named[0] ?? blank : blank);
  if (!layout) throw Error("The other deck has no layouts to create a slide with.");
  const resolve = usePlaceholders ? (v: any) => v : (v: any) => withRgb(v, scheme);
  const scale = scaler(source, target);

  const slideId = newId('slide');
  const requests: Request[] = [];
  const skipped: string[] = [];

  // The layout's placeholders appear on the new slide and the ones matching the slide's placeholders are filled. Slide
  // numbers, footers and dates aren't created on new slides (deleting one failed with "could not be found"), so they're
  // never matched; the empty ones left are removed afterwards (`emptyPlaceholders`)
  const layoutPlaceholders = (layout.pageElements ?? []).filter(e => e.shape?.placeholder && !NOT_CREATED.includes(e.shape.placeholder.type ?? '')).map(e => ({ el: e, id: newId('ph'), used: false }));
  const takePlaceholder = (p: slides_v1.Schema$Placeholder) => {
    if (NOT_CREATED.includes(p.type ?? '')) return undefined;
    const kind = placeholderKind(p.type);
    const candidates = layoutPlaceholders.filter(l => !l.used && placeholderKind(l.el.shape!.placeholder!.type) == kind);
    const match = candidates.find(l => (l.el.shape!.placeholder!.index ?? 0) == (p.index ?? 0)) ?? candidates[0];
    if (match) match.used = true;
    return match;
  };

  /** The chain of placeholders an element inherits from: itself, then its layout's, then the master's. */
  const chain = (el: PageElement): PageElement[] => {
    const list = [el];
    let parent = el.shape?.placeholder?.parentObjectId;
    while (parent && inherited.has(parent) && list.length < 5) {
      const p = inherited.get(parent)!;
      list.push(p);
      parent = p.shape?.placeholder?.parentObjectId;
    }
    return list;
  };
  /** The styles a placeholder's text inherits at a list nesting level, from the paragraph for that level above it. */
  const baseStyles = (parents: PageElement[]) => (nesting: number) => {
    const levels = [...parents].reverse().map(p => {
      const { paragraphs, runs } = textParts(p.shape?.text);
      const para = paragraphs[Math.min(nesting, paragraphs.length - 1)];
      return { paragraph: para?.style, run: para ? [...runs].reverse().find(r => r.start < para.end && r.end > para.start)?.style : undefined };
    });
    return { paragraph: merge(...levels.map(l => l.paragraph)), run: merge(...levels.map(l => l.run)) };
  };

  const props = (transform: Transform | null | undefined, size: slides_v1.Schema$Size | null | undefined): slides_v1.Schema$PageElementProperties => ({
    pageObjectId: slideId,
    ...(size ? { size } : {}),
    ...(transform ? { transform: scale(transform) } : {}),
  });

  /** Creates `el` (absolute transform `transform`) on the new slide, returning the new element's id. */
  const copyElement = (el: PageElement, transform: Transform | null | undefined): string | null => {
    const id = newId('el');
    const altText = el.title || el.description ? [{ updatePageElementAltText: { objectId: id, title: el.title ?? undefined, description: el.description ?? undefined } }] : [];
    if (el.shape) {
      const shape = el.shape;
      if (shape.placeholder && usePlaceholders) {
        const match = takePlaceholder(shape.placeholder);
        if (match) {
          // Takes the other layout's look, only the slide's own overrides are copied. It stays where it was: moving
          // matched placeholders to the layout's places overlapped the rest (a slide with three titles, tested 2026-10-25)
          const place = transform ?? chain(el).map(e => e.transform).find(Boolean);
          const size = el.size ?? chain(el).map(e => e.size).find(Boolean);
          const base = match.el.size;
          if (place && size?.width?.magnitude && size.height?.magnitude && base?.width?.magnitude && base.height?.magnitude) {
            const sx = size.width.magnitude / base.width.magnitude;
            const sy = size.height.magnitude / base.height.magnitude;
            const t = scale(place);
            requests.push({ updatePageElementTransform: { objectId: match.id, applyMode: 'ABSOLUTE', transform: { ...t, scaleX: (t.scaleX ?? 1) * sx, shearY: (t.shearY ?? 0) * sx, shearX: (t.shearX ?? 0) * sy, scaleY: (t.scaleY ?? 1) * sy } } });
          }
          // Font sizes come along too: they belong with the kept sizes (the other theme's 120pt big number overflowed)
          const inheritedSize = baseStyles(chain(el).slice(1));
          requests.push(...textRequests(match.id, shape.text, {
            colours: resolve, fontScale: shape.shapeProperties?.autofit?.fontScale ?? undefined,
            base: nesting => ({ run: { fontSize: inheritedSize(nesting).run.fontSize } }),
          }));
          return null;
        }
      }
      const parents = shape.placeholder ? chain(el) : [el];
      const first = <T>(get: (e: PageElement) => T | null | undefined, ok: (v: T) => boolean = () => true) => parents.map(get).find(v => v != null && ok(v as T)) ?? undefined;
      const notInherited = (v: { propertyState?: string | null }) => v.propertyState != 'INHERIT';
      const sp = shape.shapeProperties;
      const shapeProperties: any = {
        shapeBackgroundFill: resolve(fill(first(e => e.shape?.shapeProperties?.shapeBackgroundFill, notInherited))),
        outline: resolve(outline(first(e => e.shape?.shapeProperties?.outline, notInherited))),
      };
      const contentAlignment = first(e => e.shape?.shapeProperties?.contentAlignment, v => v != 'CONTENT_ALIGNMENT_UNSPECIFIED');
      if (contentAlignment) shapeProperties.contentAlignment = contentAlignment;
      const sizeAndPlace = props(transform ?? first(e => e.transform), el.size ?? first(e => e.size));
      requests.push(
        { createShape: { objectId: id, shapeType: shape.shapeType == 'TYPE_UNSPECIFIED' ? 'TEXT_BOX' : shape.shapeType ?? 'TEXT_BOX', elementProperties: sizeAndPlace } },
        { updateShapeProperties: { objectId: id, shapeProperties, fields: Object.keys(shapeProperties).join(',') } },
        ...textRequests(id, shape.text, { base: shape.placeholder ? baseStyles(parents.slice(1)) : undefined, fontScale: sp?.autofit?.fontScale ?? undefined, colours: resolve }),
        ...altText,
      );
      return id;
    }
    if (el.image || el.sheetsChart) {
      const url = el.image?.contentUrl ?? el.sheetsChart?.contentUrl;
      if (!url) { skipped.push(el.image ? 'an image' : 'a chart'); return null; }
      requests.push({ createImage: { objectId: id, url, elementProperties: props(transform, el.size) } });
      const o = el.image?.imageProperties?.outline;
      if (o && o.propertyState != 'NOT_RENDERED' && o.outlineFill) {
        requests.push({ updateImageProperties: { objectId: id, imageProperties: { outline: resolve(outline(o)) }, fields: 'outline' } });
      }
      requests.push(...altText);
      return id;
    }
    if (el.line) {
      const lp = el.line.lineProperties ?? {};
      const lineProperties: any = merge({ lineFill: resolve(lp.lineFill), weight: lp.weight, dashStyle: lp.dashStyle, startArrow: lp.startArrow, endArrow: lp.endArrow });
      const category = el.line.lineCategory && el.line.lineCategory != 'LINE_CATEGORY_UNSPECIFIED' ? el.line.lineCategory : 'STRAIGHT';
      requests.push({ createLine: { objectId: id, category, elementProperties: props(transform, el.size) } });
      if (Object.keys(lineProperties).length) requests.push({ updateLineProperties: { objectId: id, lineProperties, fields: Object.keys(lineProperties).join(',') } });
      requests.push(...altText);
      return id;
    }
    if (el.table) {
      copyTable(el, id, transform);
      requests.push(...altText);
      return id;
    }
    if (el.video?.id && el.video.source && el.video.source != 'SOURCE_UNSPECIFIED') {
      requests.push({ createVideo: { objectId: id, source: el.video.source, id: el.video.id, elementProperties: props(transform, el.size) } }, ...altText);
      return id;
    }
    if (el.elementGroup) {
      const children = (el.elementGroup.children ?? []).map(c => copyElement(c, compose(transform ?? {}, c.transform ?? {}))).filter(Boolean) as string[];
      if (children.length >= 2) {
        requests.push({ groupObjects: { groupObjectId: id, childrenObjectIds: children } });
        return id;
      }
      return children[0] ?? null;
    }
    skipped.push(el.wordArt ? 'word art' : el.video ? 'a video' : 'an element');
    return null;
  };

  const copyTable = (el: PageElement, id: string, transform: Transform | null | undefined) => {
    const table = el.table!;
    const rows = table.rows ?? table.tableRows?.length ?? 1;
    const columns = table.columns ?? table.tableColumns?.length ?? 1;
    requests.push({ createTable: { objectId: id, rows, columns, elementProperties: props(transform, el.size) } });
    // Borders go on before cells are merged, a border range can't cut through a merged cell
    const border = (b: slides_v1.Schema$TableBorderProperties | null | undefined) => b?.tableBorderFill?.solidFill
      ? merge<slides_v1.Schema$TableBorderProperties>({ tableBorderFill: resolve(b.tableBorderFill), weight: b.weight, dashStyle: b.dashStyle })
      : { tableBorderFill: { solidFill: { color: { rgbColor: {} }, alpha: 0 } } };
    (table.horizontalBorderRows ?? []).forEach((row, r) => (row.tableBorderCells ?? []).forEach((cell, c) => {
      const tableBorderProperties = border(cell.tableBorderProperties);
      requests.push({ updateTableBorderProperties: { objectId: id, tableRange: { location: { rowIndex: Math.min(r, rows - 1), columnIndex: Math.min(c, columns - 1) }, rowSpan: 1, columnSpan: 1 }, borderPosition: r < rows ? 'TOP' : 'BOTTOM', tableBorderProperties, fields: Object.keys(tableBorderProperties).join(',') } });
    }));
    (table.verticalBorderRows ?? []).forEach((row, r) => (row.tableBorderCells ?? []).forEach((cell, c) => {
      const tableBorderProperties = border(cell.tableBorderProperties);
      requests.push({ updateTableBorderProperties: { objectId: id, tableRange: { location: { rowIndex: Math.min(r, rows - 1), columnIndex: Math.min(c, columns - 1) }, rowSpan: 1, columnSpan: 1 }, borderPosition: c < columns ? 'LEFT' : 'RIGHT', tableBorderProperties, fields: Object.keys(tableBorderProperties).join(',') } });
    }));
    (table.tableColumns ?? []).forEach((col, c) => {
      if (col.columnWidth?.magnitude) requests.push({ updateTableColumnProperties: { objectId: id, columnIndices: [c], tableColumnProperties: { columnWidth: col.columnWidth }, fields: 'columnWidth' } });
    });
    (table.tableRows ?? []).forEach((row, r) => {
      const height = row.tableRowProperties?.minRowHeight ?? row.rowHeight;
      if (height?.magnitude) requests.push({ updateTableRowProperties: { objectId: id, rowIndices: [r], tableRowProperties: { minRowHeight: height }, fields: 'minRowHeight' } });
    });
    const cells = (table.tableRows ?? []).flatMap((row, r) => (row.tableCells ?? []).map((cell, c) => ({ cell, location: { rowIndex: cell.location?.rowIndex ?? r, columnIndex: cell.location?.columnIndex ?? c } })));
    for (const { cell, location } of cells) {
      if ((cell.rowSpan ?? 1) > 1 || (cell.columnSpan ?? 1) > 1) {
        requests.push({ mergeTableCells: { objectId: id, tableRange: { location, rowSpan: cell.rowSpan ?? 1, columnSpan: cell.columnSpan ?? 1 } } });
      }
    }
    for (const { cell, location } of cells) {
      const cp = cell.tableCellProperties;
      const tableCellProperties: any = { tableCellBackgroundFill: resolve(fill(cp?.tableCellBackgroundFill as any)) };
      if (cp?.contentAlignment && cp.contentAlignment != 'CONTENT_ALIGNMENT_UNSPECIFIED') tableCellProperties.contentAlignment = cp.contentAlignment;
      requests.push({ updateTableCellProperties: { objectId: id, tableRange: { location, rowSpan: cell.rowSpan ?? 1, columnSpan: cell.columnSpan ?? 1 }, tableCellProperties, fields: Object.keys(tableCellProperties).join(',') } });
      requests.push(...textRequests(id, cell.text, { cellLocation: location, colours: resolve }));
    }
  };

  // The background: the slide's own, or with the source look, whatever it inherits from its layout and master
  const backgroundFrom = usePlaceholders ? [slide] : [slide, sourceLayout, sourceMaster];
  const background = backgroundFrom.map(p => p?.pageProperties?.pageBackgroundFill).find(f => f && f.propertyState != 'INHERIT' && (f.solidFill || f.stretchedPictureFill));
  const pageBackgroundFill = background?.solidFill ? { solidFill: resolve(background.solidFill) } : background?.stretchedPictureFill?.contentUrl ? { stretchedPictureFill: { contentUrl: background.stretchedPictureFill.contentUrl } } : undefined;

  // The template's own shapes and images (logos, bars...) go behind the slide's, as the master and layout draw them
  if (!usePlaceholders) {
    for (const page of [sourceMaster, sourceLayout]) {
      for (const el of page?.pageElements ?? []) if (!el.shape?.placeholder) copyElement(el, el.transform);
    }
  }
  for (const el of slide.pageElements ?? []) copyElement(el, el.transform);
  // The slide is created last, once copying the elements has decided which layout placeholders they fill
  const mappings = layoutPlaceholders.filter(p => p.used).map(p => ({ layoutPlaceholderObjectId: p.el.objectId!, objectId: p.id }));
  requests.unshift(
    ...createSlideRequests(target, slideId, { layoutId: layout.objectId!, page: layout }, position, mappings),
    ...(pageBackgroundFill ? [{ updatePageProperties: { objectId: slideId, pageProperties: { pageBackgroundFill }, fields: 'pageBackgroundFill' } }] : []),
  );

  const notesPage = slide.slideProperties?.notesPage;
  const notesShape = notesPage?.pageElements?.find(e => e.objectId == notesPage.notesProperties?.speakerNotesObjectId);
  const notes = textParts(notesShape?.shape?.text).full.replace(/\n$/, '');
  return {
    slideId, requests, notes, skipped,
    layout: layout.layoutProperties?.displayName ?? layout.layoutProperties?.name ?? 'layout',
    placeholders: usePlaceholders,
  };
}
