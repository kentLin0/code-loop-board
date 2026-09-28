import { useEffect, useMemo, useState } from "react";
import Prism from "prismjs";

interface DiffCodeProps {
  path: string;
  language: string;
  lines: string;
}

type SupportedLanguage = "javascript" | "typescript" | "python" | "json" | "vue";

interface DiffLine {
  kind: "context" | "addition" | "deletion" | "meta";
  oldLine: number | null;
  newLine: number | null;
  marker: string;
  code: string;
}

const MIME_LANGUAGES: Record<string, SupportedLanguage> = {
  "application/javascript": "javascript",
  "application/json": "json",
  "application/jsx": "javascript",
  "application/tsx": "typescript",
  "application/typescript": "typescript",
  "text/javascript": "javascript",
  "text/jsx": "javascript",
  "text/tsx": "typescript",
  "text/typescript": "typescript",
  "text/x-python": "python",
  "text/x-vue": "vue",
};

const EXTENSION_LANGUAGES: Record<string, SupportedLanguage> = {
  ".cjs": "javascript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".json": "json",
  ".mjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "vue",
};

function resolveLanguage(path: string, language: string): SupportedLanguage | null {
  const normalized = language.trim().toLowerCase().split(";", 1)[0];
  if (normalized === "text" || normalized === "plain" || normalized === "plaintext" || normalized === "text/plain") {
    return null;
  }
  if (normalized in MIME_LANGUAGES) return MIME_LANGUAGES[normalized];
  if (normalized === "js" || normalized === "javascript" || normalized === "jsx") return "javascript";
  if (normalized === "ts" || normalized === "typescript" || normalized === "tsx") return "typescript";
  if (normalized === "py" || normalized === "python") return "python";
  if (normalized === "json") return "json";
  if (normalized === "vue") return "vue";
  const lowerPath = path.toLowerCase();
  const extension = Object.keys(EXTENSION_LANGUAGES).find((candidate) => lowerPath.endsWith(candidate));
  return extension ? EXTENSION_LANGUAGES[extension] : null;
}

async function loadLanguage(language: SupportedLanguage): Promise<void> {
  if (language === "javascript") {
    await import("prismjs/components/prism-javascript");
    return;
  }
  if (language === "typescript") {
    await import("prismjs/components/prism-javascript");
    await import("prismjs/components/prism-typescript");
    return;
  }
  if (language === "python") {
    await import("prismjs/components/prism-python");
    return;
  }
  if (language === "json") {
    await import("prismjs/components/prism-json");
    return;
  }
  await import("prismjs/components/prism-markup");
  await import("prismjs/components/prism-javascript");
  await import("prismjs/components/prism-typescript");
}

function parseDiff(source: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;

  return source.split("\n").map((line) => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldRemaining = Number(hunk[2] ?? "1");
      newLine = Number(hunk[3]);
      newRemaining = Number(hunk[4] ?? "1");
      inHunk = oldRemaining > 0 || newRemaining > 0;
      return { kind: "meta", oldLine: null, newLine: null, marker: "", code: line };
    }

    if (line.startsWith("diff --git ") || line.startsWith("index ")) {
      inHunk = false;
      return { kind: "meta", oldLine: null, newLine: null, marker: "", code: line };
    }
    if (!inHunk || line.startsWith("\\ No newline")) {
      return { kind: "meta", oldLine: null, newLine: null, marker: "", code: line };
    }

    if (line.startsWith("+")) {
      const row = { kind: "addition" as const, oldLine: null, newLine, marker: "+", code: line.slice(1) };
      newLine += 1;
      newRemaining = Math.max(0, newRemaining - 1);
      inHunk = oldRemaining > 0 || newRemaining > 0;
      return row;
    }
    if (line.startsWith("-")) {
      const row = { kind: "deletion" as const, oldLine, newLine: null, marker: "-", code: line.slice(1) };
      oldLine += 1;
      oldRemaining = Math.max(0, oldRemaining - 1);
      inHunk = oldRemaining > 0 || newRemaining > 0;
      return row;
    }
    if (line.startsWith(" ")) {
      const row = { kind: "context" as const, oldLine, newLine, marker: " ", code: line.slice(1) };
      oldLine += 1;
      newLine += 1;
      oldRemaining = Math.max(0, oldRemaining - 1);
      newRemaining = Math.max(0, newRemaining - 1);
      inHunk = oldRemaining > 0 || newRemaining > 0;
      return row;
    }
    return { kind: "meta", oldLine: null, newLine: null, marker: "", code: line };
  });
}

export function DiffCode({ path, language, lines }: DiffCodeProps) {
  const resolvedLanguage = useMemo(() => resolveLanguage(path, language), [language, path]);
  const languageKey = `${path}\u0000${resolvedLanguage ?? "plain"}`;
  const [loadedLanguage, setLoadedLanguage] = useState<{
    key: string;
    language: SupportedLanguage;
  } | null>(null);
  const rows = useMemo(() => parseDiff(lines), [lines]);

  useEffect(() => {
    let active = true;
    setLoadedLanguage(null);
    if (!resolvedLanguage) return () => { active = false; };
    void loadLanguage(resolvedLanguage).then(() => {
      if (active) setLoadedLanguage({ key: languageKey, language: resolvedLanguage });
    });
    return () => { active = false; };
  }, [languageKey, resolvedLanguage]);

  const activeLanguage = loadedLanguage?.key === languageKey ? loadedLanguage.language : null;
  const highlightedRows = useMemo(() => {
    const grammar = activeLanguage
      ? Prism.languages[activeLanguage === "vue" ? "markup" : activeLanguage]
      : undefined;
    return rows.map((row) => ({
      row,
      highlighted: grammar && activeLanguage && row.kind !== "meta"
        ? Prism.highlight(row.code, grammar, activeLanguage)
        : null,
    }));
  }, [activeLanguage, rows]);

  return (
    <div className="review-diff-code" aria-label={`${path} 统一差异`}>
      {highlightedRows.map(({ row, highlighted }, index) => (
          <div className={`review-diff-line is-${row.kind}`} key={`${index}-${row.oldLine ?? ""}-${row.newLine ?? ""}`}>
            <span className="review-diff-old-line" aria-hidden="true">{row.oldLine ?? ""}</span>
            <span className="review-diff-new-line" aria-hidden="true">{row.newLine ?? ""}</span>
            <span className="review-diff-marker" aria-hidden="true">{row.marker}</span>
            {highlighted === null ? (
              <code>{row.code || " "}</code>
            ) : (
              <code dangerouslySetInnerHTML={{ __html: highlighted || " " }} />
            )}
          </div>
      ))}
    </div>
  );
}
