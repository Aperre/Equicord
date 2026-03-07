/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Renders a math expression or step-by-step breakdown as a PNG image
// using the Canvas API.

const FONT_SIZE = 18;
const PADDING = 20;
const LINE_HEIGHT = FONT_SIZE * 1.5;
const FONT = `${FONT_SIZE}px "Cambria Math", "Latin Modern Math", "STIX Two Math", serif`;
const BG_COLOR = "#00000000";
const TEXT_COLOR = "#e0e0e0";
const OP_COLOR = "#7289da";
const EQ_COLOR = "#57f287";
const GRAPH_WIDTH = 760;
const GRAPH_HEIGHT = 420;
const GRAPH_PADDING_X = 56;
const GRAPH_PADDING_TOP = 72;
const GRAPH_PADDING_BOTTOM = 44;
const GRAPH_LINE_WIDTH = 3;
const GRAPH_TICK_COUNT = 4;
const GRAPH_LEGEND_SWATCH = 12;
const GRAPH_LABEL_FONT = `${FONT_SIZE - 2}px "Cambria Math", "Latin Modern Math", "STIX Two Math", serif`;
const GRAPH_COLORS = [
    "#7dd3fc",
    "#fda4af",
    "#86efac",
    "#fcd34d",
    "#c4b5fd",
    "#fb7185"
] as const;

export interface RenderColors {
    text?: string;
    operator?: string;
    equals?: string;
}

export interface GraphPoint {
    x: number;
    y: number | null;
}

export interface GraphSeries {
    label: string;
    color: string;
    points: GraphPoint[];
}

type RenderSurface = OffscreenCanvas;
type RenderContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function measureText(ctx: RenderContext, text: string): number {
    return ctx.measureText(text).width;
}

interface TextSegment {
    text: string;
    color: string;
}

function getRenderColors(colors?: RenderColors) {
    return {
        text: colors?.text?.trim() ?? TEXT_COLOR,
        operator: colors?.operator?.trim() ?? OP_COLOR,
        equals: colors?.equals?.trim() ?? EQ_COLOR,
    };
}

function segmentExpression(text: string, colors?: RenderColors): TextSegment[] {
    const resolvedColors = getRenderColors(colors);
    const segments: TextSegment[] = [];
    const regex = /(=)|([-+*/%^])|([^=+*/%^-]+)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
        if (match[1]) {
            segments.push({ text: " = ", color: resolvedColors.equals });
        } else if (match[2]) {
            segments.push({ text: ` ${match[2]} `, color: resolvedColors.operator });
        } else if (match[3]) {
            segments.push({ text: match[3], color: resolvedColors.text });
        }
    }

    return segments;
}

function formatAxisValue(value: number): string {
    return Number.isInteger(value) ? value.toString() : value.toPrecision(4).replace(/\.?0+$/, "");
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function resolveGraphRange(series: GraphSeries[]): [number, number] {
    const values = series.flatMap(entry => entry.points.map(point => point.y).filter((value): value is number => value != null));
    if (!values.length) return [-10, 10];

    let min = Math.min(...values);
    let max = Math.max(...values);

    if (min === max) {
        const padding = Math.abs(min || 1);
        min -= padding;
        max += padding;
    } else {
        const padding = Math.max((max - min) * 0.12, 1);
        min -= padding;
        max += padding;
    }

    return [min, max];
}

function toGraphX(value: number, domain: readonly [number, number]): number {
    const [min, max] = domain;
    const innerWidth = GRAPH_WIDTH - GRAPH_PADDING_X * 2;
    if (max === min) return GRAPH_PADDING_X + innerWidth / 2;
    return GRAPH_PADDING_X + ((value - min) / (max - min)) * innerWidth;
}

function toGraphY(value: number, range: readonly [number, number]): number {
    const [min, max] = range;
    const innerHeight = GRAPH_HEIGHT - GRAPH_PADDING_TOP - GRAPH_PADDING_BOTTOM;
    if (max === min) return GRAPH_PADDING_TOP + innerHeight / 2;
    return GRAPH_PADDING_TOP + innerHeight - ((value - min) / (max - min)) * innerHeight;
}

function drawGraphLine(ctx: RenderContext, fromX: number, fromY: number, toX: number, toY: number) {
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();
}

export function getGraphColor(index: number): string {
    return GRAPH_COLORS[index % GRAPH_COLORS.length];
}

export function renderMathToCanvas(expression: string, steps?: string, colors?: RenderColors): RenderSurface {
    // Determine content
    const displayText = steps || expression;
    const lines = displayText.split("\n");

    const measureCanvas = new OffscreenCanvas(1, 1);
    const measureCtx = measureCanvas.getContext("2d");
    if (!measureCtx) throw new Error("Failed to create canvas context");
    measureCtx.font = FONT;

    // Measure
    let maxWidth = 0;
    for (const line of lines) {
        const w = measureText(measureCtx, line.replace(/\\\*/g, "*")) + PADDING * 2;
        if (w > maxWidth) maxWidth = w;
    }

    const canvas = new OffscreenCanvas(maxWidth + PADDING, lines.length * LINE_HEIGHT + PADDING * 2);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create canvas context");

    canvas.width = maxWidth + PADDING;
    canvas.height = lines.length * LINE_HEIGHT + PADDING * 2;

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.beginPath();
    const r = 12;
    const w = canvas.width;
    const h = canvas.height;
    ctx.moveTo(r, 0);
    ctx.arcTo(w, 0, w, h, r);
    ctx.arcTo(w, h, 0, h, r);
    ctx.arcTo(0, h, 0, 0, r);
    ctx.arcTo(0, 0, w, 0, r);
    ctx.closePath();
    ctx.fill();

    // Render text
    ctx.textBaseline = "middle";

    for (let i = 0; i < lines.length; i++) {
        const y = PADDING + i * LINE_HEIGHT + LINE_HEIGHT / 2;
        const line = lines[i].replace(/\\\*/g, "*");
        const segments = segmentExpression(line, colors);

        let x = PADDING;
        for (const seg of segments) {
            ctx.font = FONT;
            ctx.fillStyle = seg.color;
            ctx.fillText(seg.text, x, y);
            x += measureText(ctx, seg.text);
        }
    }

    return canvas;
}

export function renderGraphToCanvas(series: GraphSeries[], colors?: RenderColors, domain: readonly [number, number] = [-10, 10]): RenderSurface {
    const resolvedColors = getRenderColors(colors);
    const range = resolveGraphRange(series);
    const canvas = new OffscreenCanvas(GRAPH_WIDTH, GRAPH_HEIGHT);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create canvas context");

    canvas.width = GRAPH_WIDTH;
    canvas.height = GRAPH_HEIGHT;

    ctx.fillStyle = BG_COLOR;
    ctx.beginPath();
    const radius = 12;
    ctx.moveTo(radius, 0);
    ctx.arcTo(GRAPH_WIDTH, 0, GRAPH_WIDTH, GRAPH_HEIGHT, radius);
    ctx.arcTo(GRAPH_WIDTH, GRAPH_HEIGHT, 0, GRAPH_HEIGHT, radius);
    ctx.arcTo(0, GRAPH_HEIGHT, 0, 0, radius);
    ctx.arcTo(0, 0, GRAPH_WIDTH, 0, radius);
    ctx.closePath();
    ctx.fill();

    ctx.font = GRAPH_LABEL_FONT;
    ctx.textBaseline = "middle";

    let legendX = GRAPH_PADDING_X;
    for (const entry of series) {
        ctx.fillStyle = entry.color;
        ctx.fillRect(legendX, 24, GRAPH_LEGEND_SWATCH, GRAPH_LEGEND_SWATCH);
        legendX += GRAPH_LEGEND_SWATCH + 8;

        ctx.fillStyle = resolvedColors.text;
        ctx.fillText(entry.label, legendX, 30);
        legendX += measureText(ctx, entry.label) + 18;
    }

    ctx.strokeStyle = resolvedColors.text;
    ctx.globalAlpha = 0.12;
    for (let tick = 0; tick <= GRAPH_TICK_COUNT; tick++) {
        const ratio = tick / GRAPH_TICK_COUNT;
        const x = GRAPH_PADDING_X + (GRAPH_WIDTH - GRAPH_PADDING_X * 2) * ratio;
        const y = GRAPH_PADDING_TOP + (GRAPH_HEIGHT - GRAPH_PADDING_TOP - GRAPH_PADDING_BOTTOM) * ratio;
        drawGraphLine(ctx, x, GRAPH_PADDING_TOP, x, GRAPH_HEIGHT - GRAPH_PADDING_BOTTOM);
        drawGraphLine(ctx, GRAPH_PADDING_X, y, GRAPH_WIDTH - GRAPH_PADDING_X, y);
    }
    ctx.globalAlpha = 1;

    const axisX = toGraphY(clamp(0, range[0], range[1]), range);
    const axisY = toGraphX(clamp(0, domain[0], domain[1]), domain);
    ctx.strokeStyle = resolvedColors.equals;
    drawGraphLine(ctx, GRAPH_PADDING_X, axisX, GRAPH_WIDTH - GRAPH_PADDING_X, axisX);
    drawGraphLine(ctx, axisY, GRAPH_PADDING_TOP, axisY, GRAPH_HEIGHT - GRAPH_PADDING_BOTTOM);

    ctx.fillStyle = resolvedColors.text;
    for (let tick = 0; tick <= GRAPH_TICK_COUNT; tick++) {
        const ratio = tick / GRAPH_TICK_COUNT;
        const domainValue = domain[0] + (domain[1] - domain[0]) * ratio;
        const rangeValue = range[1] - (range[1] - range[0]) * ratio;
        const x = GRAPH_PADDING_X + (GRAPH_WIDTH - GRAPH_PADDING_X * 2) * ratio;
        const y = GRAPH_PADDING_TOP + (GRAPH_HEIGHT - GRAPH_PADDING_TOP - GRAPH_PADDING_BOTTOM) * ratio;

        ctx.fillText(formatAxisValue(domainValue), x - 12, GRAPH_HEIGHT - 18);
        ctx.fillText(formatAxisValue(rangeValue), 8, y);
    }

    for (const entry of series) {
        ctx.beginPath();
        ctx.strokeStyle = entry.color;
        ctx.lineWidth = GRAPH_LINE_WIDTH;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        let drawing = false;
        for (const point of entry.points) {
            if (point.y == null) {
                drawing = false;
                continue;
            }

            const x = toGraphX(point.x, domain);
            const y = toGraphY(point.y, range);
            if (drawing) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
            drawing = true;
        }

        ctx.stroke();
    }

    return canvas;
}

export async function canvasToBlob(canvas: RenderSurface): Promise<Blob> {
    return canvas.convertToBlob({ type: "image/png" });
}
