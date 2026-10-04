import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { relative } from "node:path";

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

class PromptBarEditor extends CustomEditor {
  private getTheme: () => Theme;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    editorTheme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    getTheme: () => Theme,
  ) {
    super(tui, editorTheme, keybindings);
    this.getTheme = getTheme;
  }

  render(width: number): string[] {
    const theme = this.getTheme();
    let autocomplete = false;
    const lines = super.render(Math.max(1, width - 4)).flatMap((line, index) => {
      if (index === 0) return [];
      const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      if (/^[─↑↓]+(?: \d+ more)?$/.test(plain.trim())) {
        autocomplete = true;
        return [];
      }
      // Override menu styling so only the selected row uses bright text.
      return [autocomplete
        ? theme.fg(plain.trimStart().startsWith("→ ") ? "text" : "muted", plain)
        : line];
    });
    const background = theme.getBgAnsi("userMessageBg");
    const blockWidth = Math.max(1, width - 2);
    const block = lines.map((line) => {
      const content = `┃ ${line}${" ".repeat(Math.max(0, blockWidth - 2 - visibleWidth(line)))}`;
      const styled =
        theme.getFgAnsi("userMessageText") +
        "┃\x1b[39m " +
        content.slice(2).replace(/\x1b\[0m/g, `\x1b[0m${background}`);
      return `${background} ${styled} \x1b[49m`;
    });
    const margin = `${background}${" ".repeat(width)}\x1b[49m`;
    return [margin, ...block, margin, " ".repeat(width)];
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new PromptBarEditor(tui, theme, keybindings, () => ctx.ui.theme),
    );
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          let input = 0;
          let output = 0;
          let cost = 0;
          let latestCacheHit: number | undefined;
          let assistantMessages = 0;
          for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type !== "message" || entry.message.role !== "assistant")
              continue;
            const message = entry.message as AssistantMessage;
            input += message.usage.input;
            output += message.usage.output;
            cost += message.usage.cost.total;
            assistantMessages++;
            const promptTokens = message.usage.input + message.usage.cacheRead;
            latestCacheHit = promptTokens === 0
              ? undefined
              : (message.usage.cacheRead / promptTokens) * 100;
          }

          const usage = ctx.getContextUsage();
          const settings = pi.getSettings().compaction;
          const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
          const reserveTokens = settings?.modelOverrides?.[modelKey]?.reserveTokens ?? settings?.reserveTokens ?? 16_384;
          const thresholdPercent = usage ? ((usage.contextWindow - reserveTokens) / usage.contextWindow) * 100 : 0;
          const contextPercent = usage?.percent;
          const contextColor = contextPercent === null || contextPercent === undefined || !usage
            ? undefined
            : contextPercent > thresholdPercent
              ? "red"
              : contextPercent >= thresholdPercent - 5
                ? "orange"
                : undefined;
          const cacheColor = assistantMessages > 1 && latestCacheHit !== undefined
            ? latestCacheHit < 20 ? "red" : latestCacheHit < 50 ? "orange" : undefined
            : undefined;
          const color = (text: string, level: "orange" | "red" | undefined) =>
            level === "orange" ? theme.fg("warning", text)
              : level === "red" ? theme.fg("error", text)
                : theme.fg("muted", text);
          const stats =
            theme.fg("muted", `↑${formatTokens(input)} ↓${formatTokens(output)} `) +
            color(`✓${latestCacheHit?.toFixed(1) ?? "0.0"}%`, cacheColor) +
            theme.fg("muted", ` · $${cost.toFixed(3)}`) +
            (usage
              ? theme.fg("muted", " · ") +
                color(`${contextPercent?.toFixed(1) ?? "0.0"}%`, contextColor) +
                theme.fg("muted", `/${formatTokens(usage.contextWindow)}`)
              : "");
          const cwd = relative(homedir(), ctx.cwd);
          const displayCwd =
            cwd === "" ? "~" : cwd.startsWith("..") ? ctx.cwd : `~/${cwd}`;
          const branch = footerData.getGitBranch();
          const location = `${displayCwd}${branch ? ` (${branch})` : ""}`;
          const left = theme.fg("muted", `${ctx.model?.id ? ctx.model.id + " " : ""}${ctx.thinkingLevel ? `(${ctx.thinkingLevel})` : ""}${ctx.model?.id || ctx.thinkingLevel ? " · " : ""}`) + stats;
          const gap = " ".repeat(
            Math.max(1, width - visibleWidth(left) - visibleWidth(location)),
          );
          const lines = [
            truncateToWidth(left + gap + theme.fg("muted", location), width),
          ];
          const statuses = Array.from(
            footerData.getExtensionStatuses().entries(),
          )
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) =>
              text
                .replace(/[\r\n\t]/g, " ")
                .replace(/ +/g, " ")
                .trim(),
            );
          if (statuses.length > 0) {
            lines.push(
              truncateToWidth(
                statuses.join(" "),
                width,
                theme.fg("dim", "..."),
              ),
            );
          }
          return lines;
        },
      };
    });
  });
}
