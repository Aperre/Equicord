/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, ComponentDispatch, DraftType, Forms, PermissionsBits, PermissionStore, showToast, Toasts, UploadHandler, UserStore } from "@webpack/common";

import { createEvaluationState, evaluateDetachedExpression, evaluateExpressionWithOutputs, sampleGraphExpression } from "./parser";
import { canvasToBlob, getGraphColor, type GraphSeries, renderGraphToCanvas, renderMathToCanvas } from "./renderer";
import { tryConvertUnits } from "./units";

const settings = definePluginSettings({
    showSteps: {
        type: OptionType.BOOLEAN,
        description: "Show step-by-step decomposition of calculations.",
        default: false
    },
    imageOutput: {
        type: OptionType.BOOLEAN,
        description: "Render calculation result as an image instead of text.",
        default: false
    },
    textColor: {
        type: OptionType.STRING,
        description: "Text color for rendered images.",
        default: "#e0e0e0"
    },
    operatorColor: {
        type: OptionType.STRING,
        description: "Operator color for rendered images.",
        default: "#7289da"
    },
    equalsColor: {
        type: OptionType.STRING,
        description: "Equals sign color for rendered images.",
        default: "#57f287"
    }
});

function resolveExpr(raw: string): string {
    return raw;
}

function splitTopLevelArgs(input: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;

    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (char === "(") depth++;
        else if (char === ")") depth--;
        else if (char === "," && depth === 0) {
            parts.push(input.slice(start, i).trim());
            start = i + 1;
        }
    }

    parts.push(input.slice(start).trim());
    return parts;
}

function getGraphCall(raw: string): { expression: string; domain?: readonly [string, string]; } | null {
    const trimmed = raw.trim();
    if (!trimmed.toLowerCase().startsWith("graph(") || !trimmed.endsWith(")")) return null;

    let depth = 0;
    for (let i = 5; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (char === "(") depth++;
        if (char === ")") depth--;
        if (depth === 0 && i !== trimmed.length - 1) return null;
    }

    if (depth !== 0) return null;

    const inner = trimmed.slice(6, -1).trim();
    if (!inner) return null;

    const args = splitTopLevelArgs(inner);
    if (args.length === 1) return { expression: args[0] };
    if (args.length !== 3 || args.some(arg => !arg)) return null;

    return {
        expression: args[0],
        domain: [args[1], args[2]],
    };
}

function resolveGraphDomain(domain: readonly [string, string] | undefined, state: ReturnType<typeof createEvaluationState>): readonly [number, number] {
    if (!domain) return [-10, 10];

    const [minExpr, maxExpr] = domain;
    const min = evaluateDetachedExpression(resolveExpr(minExpr), state);
    const max = evaluateDetachedExpression(resolveExpr(maxExpr), state);
    if (min.statementKind !== "expr_stmt" || max.statementKind !== "expr_stmt")
        throw new Error("Graph domain must be expressions");

    return [min.result, max.result];
}

function resolveCombinedGraphDomain(domains: readonly (readonly [number, number])[]): readonly [number, number] {
    if (!domains.length) return [-10, 10];

    let min = domains[0][0];
    let max = domains[0][1];
    for (const [domainMin, domainMax] of domains) {
        if (domainMin < min) min = domainMin;
        if (domainMax > max) max = domainMax;
    }

    return [min, max];
}

function canUploadInChannel(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return null;
    return channel.isPrivate() || PermissionStore.can(PermissionsBits.ATTACH_FILES, channel) ? channel : null;
}

const exampleStyle = {
    fontFamily: "var(--font-code)",
    backgroundColor: "var(--background-secondary)",
    borderRadius: "4px",
    padding: "2px 6px",
    fontSize: "0.875rem"
} as const;

export default definePlugin({
    name: "InlineMath",
    description: "Evaluate inline {math expressions} in messages.",
    authors: [EquicordDevs.ape],
    tags: ["math", "calculate", "calculator"],
    settings,

    settingsAboutComponent: () => (
        <>
            <Forms.FormTitle style={{ marginTop: 12 }}>Supported Functions</Forms.FormTitle>
            <Forms.FormText>
                <span style={exampleStyle}>
                    sin cos tan asin acos atan atan2 sinh cosh tanh sqrt cbrt abs ceil floor round trunc sign log log2 log10 ln exp pow min max hypot deg rad
                </span>
            </Forms.FormText>

            <Forms.FormTitle style={{ marginTop: 12 }}>Supported Constants</Forms.FormTitle>
            <Forms.FormText>
                <span style={exampleStyle}>
                    pi e tau phi inf ln2 ln10 sqrt2
                </span>
            </Forms.FormText>
        </>
    ),

    async onBeforeMessageSend(channelId, msg) {
        const maxLen = (UserStore.getCurrentUser().premiumType ?? 0) === 2 ? 4000 : 2000;
        const evalState = createEvaluationState();

        // Collect expressions for potential image rendering
        const exprs: { raw: string; detailed?: string; simple: string; }[] = [];
        const graphs: GraphSeries[] = [];
        const graphDomains: [number, number][] = [];
        const matches = Array.from(msg.content.matchAll(/\{([^{}]+)\}/g));
        if (matches.length === 0) return;
        const hasGraphCall = matches.some(match => getGraphCall(match[1]) != null);

        let hasMatch = false;
        let lastIndex = 0;
        let replaced = "";
        let simpleReplaced = "";
        let uploadReplaced = "";

        for (const match of matches) {
            const fullMatch = match[0];
            const rawExpr = match[1];
            const matchIndex = match.index ?? 0;
            const plainText = msg.content.slice(lastIndex, matchIndex);

            replaced += plainText;
            simpleReplaced += plainText;
            uploadReplaced += plainText;

            let detailedReplacement = fullMatch;
            let simpleReplacement = fullMatch;
            let uploadReplacement = fullMatch;

            try {
                const graphCall = getGraphCall(rawExpr);
                if (graphCall) {
                    const domain = resolveGraphDomain(graphCall.domain, evalState);
                    graphs.push({
                        label: graphCall.expression,
                        color: getGraphColor(graphs.length),
                        points: sampleGraphExpression(resolveExpr(graphCall.expression), evalState, domain),
                    });
                    graphDomains.push([domain[0], domain[1]]);
                    hasMatch = true;
                    uploadReplacement = "";
                } else {
                    // Try unit conversion first (e.g. "5 km to miles")
                    const conversion = tryConvertUnits(rawExpr);
                    if (conversion) {
                        hasMatch = true;
                        detailedReplacement = conversion;
                        simpleReplacement = conversion;
                        uploadReplacement = conversion;
                    } else {
                        const expr = resolveExpr(rawExpr);
                        const { statementKind, simpleText, detailedText } = evaluateExpressionWithOutputs(expr, evalState);
                        hasMatch = true;

                        if (statementKind === "function_def") {
                            detailedReplacement = "";
                            simpleReplacement = "";
                            uploadReplacement = "";
                        } else if (settings.store.imageOutput && !hasGraphCall) {
                            exprs.push({
                                raw: rawExpr,
                                detailed: settings.store.showSteps ? detailedText : undefined,
                                simple: simpleText,
                            });
                            detailedReplacement = simpleText;
                            simpleReplacement = simpleText;
                            uploadReplacement = "";
                        } else {
                            detailedReplacement = settings.store.showSteps ? detailedText : simpleText;
                            simpleReplacement = simpleText;
                            uploadReplacement = detailedReplacement;
                        }
                    }
                }
            } catch {
                detailedReplacement = fullMatch;
                simpleReplacement = fullMatch;
                uploadReplacement = fullMatch;
            }

            replaced += detailedReplacement;
            simpleReplaced += simpleReplacement;
            uploadReplaced += uploadReplacement;
            lastIndex = matchIndex + fullMatch.length;
        }

        if (!hasMatch) return;

        replaced += msg.content.slice(lastIndex);
        simpleReplaced += msg.content.slice(lastIndex);
        uploadReplaced += msg.content.slice(lastIndex);

        // Image output mode: send text normally, then prompt image upload
        const channel = canUploadInChannel(channelId);
        if (graphs.length > 0 && channel) {
            const canvas = renderGraphToCanvas(graphs, {
                text: settings.store.textColor,
                operator: settings.store.operatorColor,
                equals: settings.store.equalsColor
            }, resolveCombinedGraphDomain(graphDomains));

            canvasToBlob(canvas).then(blob => {
                const file = new File([blob], "graph.png", { type: "image/png" });
                UploadHandler.promptToUpload([file], channel, DraftType.ChannelMessage);
            }).catch(() => {
                showToast("[InlineMath] Failed to render graph image.", Toasts.Type.FAILURE);
            });

            ComponentDispatch.dispatchToLastSubscribed("CLEAR_TEXT");
            setTimeout(() => {
                ComponentDispatch.dispatchToLastSubscribed("INSERT_TEXT", {
                    rawText: uploadReplaced,
                    plainText: uploadReplaced
                });
            }, 50);

            return { cancel: true };
        }

        if (settings.store.imageOutput && exprs.length > 0 && channel) {
            replaced = uploadReplaced;

            const imageLines = exprs.map(e => {
                if (e.detailed) return e.detailed.replace(/\s*;\s*/g, "\n");
                return `${e.raw} = ${e.simple}`.replace(/\s*;\s*/g, "\n");
            });

            const canvas = renderMathToCanvas(
                imageLines.join("\n"),
                undefined,
                {
                    text: settings.store.textColor,
                    operator: settings.store.operatorColor,
                    equals: settings.store.equalsColor
                }
            );

            canvasToBlob(canvas).then(blob => {
                const file = new File([blob], "calculation.png", { type: "image/png" });
                UploadHandler.promptToUpload([file], channel, DraftType.ChannelMessage);
            }).catch(() => {
                showToast("[InlineMath] Failed to render calculation image.", Toasts.Type.FAILURE);
            });

            ComponentDispatch.dispatchToLastSubscribed("CLEAR_TEXT");
            setTimeout(() => {
                ComponentDispatch.dispatchToLastSubscribed("INSERT_TEXT", {
                    rawText: replaced,
                    plainText: replaced
                });
            }, 50);

            return { cancel: true };
        }

        // Text output mode
        msg.content = replaced;

        // If steps made it too long, fall back to just the result
        if (msg.content.length > maxLen && settings.store.showSteps) {
            msg.content = simpleReplaced;
        }

        if (msg.content.length > maxLen) {
            msg.content = msg.content.slice(0, maxLen);
        }
    },
});
