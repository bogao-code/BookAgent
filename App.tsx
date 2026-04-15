// src/App.tsx
import React, { useState, useCallback, useRef } from 'react';
import type { StoryPage } from './types';
import {
  parseStoryIntoPages,
  generateImage,
  refineStoryForPageCount,
  directorCheckFrame,
  directorCheckIdentity,
  directorCheckSequence,
  safetyCheckText,
  safetyCheckImage,
  extractCharacters,
} from './services/geminiService';
import type { ExtractedCharacter } from './services/geminiService';
import Loader from './components/Loader';
import { MagicWandIcon } from './components/icons/MagicWandIcon';

// === 闭环相关默认超参数（可在 UI 里调） ===
const DEFAULT_FRAME_THRESHOLD = 0.75;
const DEFAULT_MAX_FRAME_RETRY = 3;

const DEFAULT_SEQUENCE_THRESHOLD = 0.8;
const DEFAULT_MAX_SEQUENCE_RETRY = 1; // 全局只再修一次，避免太慢

// 让每页可带 imageError（不改你原 types 也能用）
type StoryPageEx = StoryPage & { imageError?: string };

function ErrorModal({
  error,
  onClose,
}: {
  error: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-800 shadow-2xl border border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">
            Generation Error
          </h3>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:opacity-80"
          >
            Close
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
            Copy this message to debug (DevTools → Console / Network). 常见原因：API key 缺失/权限不足(401/403)、限流(429)、模型名不对、返回格式不对等。
          </p>
          <pre className="whitespace-pre-wrap break-words text-sm bg-gray-50 dark:bg-gray-900/40 rounded-xl p-4 border border-gray-200 dark:border-gray-700 text-red-600 dark:text-red-300">
            {error}
          </pre>

          <div className="mt-4 flex gap-3 justify-end">
            <button
              onClick={() => navigator.clipboard?.writeText(error).catch(() => {})}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
            >
              Copy
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-100 hover:opacity-80"
            >
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const App: React.FC = () => {
  const [storyText, setStoryText] = useState<string>('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingMessage, setLoadingMessage] = useState<string>('');
  const [storybookPages, setStorybookPages] = useState<StoryPageEx[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [pageCount, setPageCount] = useState<number>(6);
  const [style, setStyle] = useState<string>(
    "whimsical, cute, soft-color children's picture-book style"
  );

// Character reference assets (for paper/demo)
const [characterSheets, setCharacterSheets] = useState<
  { id: string; name: string; url: string }[]
>([]);


  // Advanced loop controls
  const [frameThreshold, setFrameThreshold] = useState<number>(DEFAULT_FRAME_THRESHOLD);
  const [maxFrameRetry, setMaxFrameRetry] = useState<number>(DEFAULT_MAX_FRAME_RETRY);
  const [sequenceThreshold, setSequenceThreshold] = useState<number>(DEFAULT_SEQUENCE_THRESHOLD);
  const [maxSequenceRetry, setMaxSequenceRetry] = useState<number>(DEFAULT_MAX_SEQUENCE_RETRY);

  const [safetyNote, setSafetyNote] = useState<string | null>(null);

  const [reviewFeedback, setReviewFeedback] = useState<string | null>(null);
  const [frameDirectorSummary, setFrameDirectorSummary] = useState<string | null>(null);
  const [sequenceDirectorSummary, setSequenceDirectorSummary] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);


// ========= Character Sheets (global consistency) =========
// We generate (or reuse user-provided) character reference images once per book,
// then feed them as refs for every page to keep characters consistent.
const extractedCharactersRef = useRef<ExtractedCharacter[]>([]);
const characterSheetMapRef = useRef<Record<string, string>>({});


  // ========= 整页导出 =========

  const exportPageAsImage = (page: StoryPageEx): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!page.imageUrl || typeof document === 'undefined') {
        resolve();
        return;
      }

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const padding = 40;
        const textAreaHeight = 260;

        const width = img.width;
        const height = img.height + textAreaHeight;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context not available'));
          return;
        }

        ctx.drawImage(img, 0, 0, width, img.height);

        ctx.fillStyle = '#111827';
        ctx.fillRect(0, img.height, width, textAreaHeight);

        ctx.fillStyle = '#F9FAFB';
        ctx.font = '20px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textBaseline = 'top';

        const lineHeight = 28;
        const maxWidth = width - padding * 2;

        const wrapText = (text: string): string[] => {
          const words = text.split(' ');
          const lines: string[] = [];
          let currentLine = '';

          for (const word of words) {
            const testLine = currentLine ? currentLine + ' ' + word : word;
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth) {
              if (currentLine) lines.push(currentLine);
              currentLine = word;
            } else {
              currentLine = testLine;
            }
          }
          if (currentLine) lines.push(currentLine);
          return lines;
        };

        const lines = wrapText(page.text);

        lines.forEach((line, idx) => {
          const y = img.height + padding + idx * lineHeight;
          if (y + lineHeight < height - padding * 1.8) {
            ctx.fillText(line, padding, y);
          }
        });

        const pageLabel = `Page ${page.pageNumber}`;
        ctx.font = '18px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
        const metrics = ctx.measureText(pageLabel);
        ctx.fillStyle = '#6366F1';
        ctx.fillText(
          pageLabel,
          width - padding - metrics.width,
          height - padding - lineHeight / 2
        );

        const dataUrl = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `page-${page.pageNumber}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        resolve();
      };

      img.onerror = (err) => reject(err);
      img.src = page.imageUrl;
    });
  };

  const handleDownloadAll = async () => {
    for (const page of storybookPages) {
      await exportPageAsImage(page);
    }
  };


const handleDownloadReferenceSheets = () => {
  const download = (dataUrl: string, filename: string) => {
    if (!dataUrl || typeof document === 'undefined') return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  characterSheets.forEach((s, idx) => {
    const safeName = (s.name || `character_${idx + 1}`).replace(/\s+/g, '_');
    download(s.url, `ref_${idx + 1}_${safeName}.png`);
  });
};


  // ========= 上传 / 重置 =========

  const handleImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeImage = () => {
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const resetApp = () => {
    setStoryText('');
    setImageFile(null);
    setImagePreview(null);
    setIsLoading(false);
    setLoadingMessage('');
    setStorybookPages([]);
    setError(null);
    setPageCount(6);
    setStyle("whimsical, cute, soft-color children's picture-book style");
    setFrameThreshold(DEFAULT_FRAME_THRESHOLD);
    setMaxFrameRetry(DEFAULT_MAX_FRAME_RETRY);
    setSequenceThreshold(DEFAULT_SEQUENCE_THRESHOLD);
    setMaxSequenceRetry(DEFAULT_MAX_SEQUENCE_RETRY);
    setSafetyNote(null);
    extractedCharactersRef.current = [];
    characterSheetMapRef.current = {};
    setCharacterSheets([]);
    setReviewFeedback(null);
    setFrameDirectorSummary(null);
    setSequenceDirectorSummary(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // ========= 主流程（带闭环） =========

  const handleGenerateClick = useCallback(async () => {
    if (!storyText.trim()) {
      setError('Please write a story first.');
      return;
    }

    const safePageCount = Math.min(Math.max(pageCount || 1, 1), 20);

    setIsLoading(true);
    setError(null);
    setStorybookPages([]);
    setReviewFeedback(null);
    setFrameDirectorSummary(null);
    setSequenceDirectorSummary(null);
    setSafetyNote(null);
    extractedCharactersRef.current = [];
    characterSheetMapRef.current = {};
    setCharacterSheets([]);
    setLoadingMessage('Reviewing your story for quality, length, and style...');

    try {
      const SAFETY_SUFFIX =
        "\nCHILD-SAFE ONLY: no nudity, no sexual content, no suggestive themes, no adult romance, no violence, no gore.";

      // 0) Safety check (text) - before refine
      setLoadingMessage('Safety check: verifying story is suitable for children...');
      let safeInputStory = storyText;
      const s0 = await safetyCheckText(safeInputStory, 'check');
      if (!s0.isSafe) {
        const s0b = await safetyCheckText(safeInputStory, 'sanitize');
        if (!s0b.sanitizedText || !s0b.sanitizedText.trim()) {
          throw new Error(`Story blocked by safety policy: ${s0.reasons.join('; ')}`);
        }
        safeInputStory = s0b.sanitizedText;
        setSafetyNote(`Safety filter: adjusted the story to be child-friendly. Reasons: ${s0.reasons.join('; ')}`);
      }

      // 1) reviewer + refiner：先评审 + 轻改/重写
      const refine = await refineStoryForPageCount(
        safeInputStory,
        safePageCount,
        style
      );
      let refinedStory = refine.finalStory;
      const { mode, feedback } = refine;

      // 1.5) Safety check (text) - after refine
      setLoadingMessage('Safety check: verifying refined story...');
      const s1 = await safetyCheckText(refinedStory, 'check');
      if (!s1.isSafe) {
        const s1b = await safetyCheckText(refinedStory, 'sanitize');
        if (!s1b.sanitizedText || !s1b.sanitizedText.trim()) {
          throw new Error(`Refined story blocked by safety policy: ${s1.reasons.join('; ')}`);
        }
        refinedStory = s1b.sanitizedText;
        setSafetyNote((prev) => {
          const extra = `Refined story also needed safety cleanup: ${s1.reasons.join('; ')}`;
          return prev ? prev + "\n" + extra : 'Safety filter: ' + extra;
        });
      }

      setReviewFeedback(
        `${mode === "good_polish" ? "✅ Story is already reasonably good (lightly polished)." : "✏️ Story needed a stronger rewrite to fit the target."} ${feedback}`
      );

      // 2) 用 refine 后（且已安全审查）的故事做分页
      setLoadingMessage('Crafting your story outline...');
      const parsedPages = await parseStoryIntoPages(
        refinedStory,
        imageFile,
        safePageCount,
        style
      );
      // 2.5) Generate character reference sheets (anchor assets)
      setLoadingMessage('Creating character reference sheets for consistency...');
      let extractedCharacters = await extractCharacters(refinedStory, style);
      if (!extractedCharacters || extractedCharacters.length === 0) {
        extractedCharacters = [
          {
            id: 'main_character',
            name: 'Main character',
            visualDescription: 'the main character described in the story',
          },
        ];
      }
      // We support up to 5 recurring characters for consistency.
      extractedCharacters = extractedCharacters.slice(0, 5);
      extractedCharactersRef.current = extractedCharacters;

      characterSheetMapRef.current = {};
    setCharacterSheets([]);

      for (let ci = 0; ci < extractedCharacters.length; ci++) {
        const ch = extractedCharacters[ci];

        const sheetPrompt =
          `CHARACTER SHEET for ${ch.name}.\n` +
          `Style: ${style}.\n` +
          `Clean neutral background. Full body, clear view.\n` +
          `Exact character: ${ch.visualDescription}.\n` +
          `Do not add extra props unless described.\n` +
          `CHILD-SAFE ONLY: no violence, no gore, no adult themes.`;

        const sheetUrl = await generateImage(sheetPrompt);
        characterSheetMapRef.current[ch.id] = sheetUrl;
      }

      // (Group sheet disabled) We found it can introduce unexpected extra characters.

// Expose reference sheets to UI (for demo/paper)
      const uiSheets = extractedCharacters
        .map((c) => ({
          id: c.id,
          name: c.name || c.id,
          url: characterSheetMapRef.current[c.id],
        }))
        .filter((x): x is { id: string; name: string; url: string } => Boolean(x.url));
      setCharacterSheets(uiSheets);


      const pagesWithImages: StoryPageEx[] = (parsedPages as StoryPageEx[]).map((p) => ({
        ...p,
        imageUrl: undefined,
        imageError: undefined,
      }));

      setStorybookPages(pagesWithImages);

      // 3) Frame-level 闭环：每一页反复生成 + 打分 + 修 prompt

      // Detect characters explicitly mentioned in (text + prompt).
      // IMPORTANT: do NOT fall back to "all characters" — that can cause the model
      // to hallucinate extra characters on pages where the text implies "alone".
      const detectCharacterIdsForPageExplicit = (
        page: { text: string; imagePrompt: string },
        chars: ExtractedCharacter[]
      ): string[] => {
        if (!chars || chars.length === 0) return [];
        const hay = `${page.text}\n${page.imagePrompt}`.toLowerCase();
        const hits = chars
          .filter((c) => c.name && hay.includes(c.name.toLowerCase()))
          .map((c) => c.id);
        return Array.from(new Set(hits)).slice(0, 5);
      };

      const getPageCharacterIds = (pageIndex: number): string[] => {
        const chars = extractedCharactersRef.current || [];
        if (!chars.length) return [];

        const mainId = chars[0]?.id;
        const page = pagesWithImages[pageIndex];

        const detected = detectCharacterIdsForPageExplicit(
          { text: page.text, imagePrompt: page.imagePrompt },
          chars
        );

        // If no explicit mention (pronouns / implied presence), inherit from previous page
        // (but still keep it minimal) to preserve continuity without forcing the full cast.
        let fallback: string[] = [];
        if (detected.length === 0 && pageIndex > 0) {
          const prev = pagesWithImages[pageIndex - 1];
          fallback = detectCharacterIdsForPageExplicit(
            { text: prev.text, imagePrompt: prev.imagePrompt },
            chars
          );
        }

        const ids = Array.from(new Set([mainId, ...(detected.length ? detected : fallback)].filter(Boolean))) as string[];
        return ids.length ? ids.slice(0, 5) : (mainId ? [mainId] : chars.map((c) => c.id).slice(0, 1));
      };

      const getCharacterLockTextForPage = (pageIndex: number) => {
        const chars = extractedCharactersRef.current || [];
        const ids = getPageCharacterIds(pageIndex);
        const lines = ids
          .map((id) => chars.find((c) => c.id === id))
          .filter(Boolean)
          .map((c) => `- ${c!.name}: ${c!.visualDescription}`);
        return lines.join("\n");
      };

      const buildRefsForPage = (pageIndex: number): string[] => {
        const refs: string[] = [];
        const chars = extractedCharactersRef.current || [];
        const ids = getPageCharacterIds(pageIndex);

        // 0) STYLE reference (convention): referenceDataUrls[0] is the previous page image,
        // used for style continuity ONLY.
        if (pageIndex > 0 && pagesWithImages[pageIndex - 1]?.imageUrl) {
          refs.push(pagesWithImages[pageIndex - 1].imageUrl as string);
        }

        // 1) Include only the character sheets needed for THIS page.
        for (const id of ids) {
          const sheet = characterSheetMapRef.current[id];
          if (sheet) refs.push(sheet);
        }

        // 2) Deduplicate while preserving order.
        const seen = new Set<string>();
        const out: string[] = [];
        for (const r of refs) {
          if (!r) continue;
          if (seen.has(r)) continue;
          seen.add(r);
          out.push(r);
          if (out.length >= 14) break;
        }
        return out;
      };

      const frameIssuesAll: string[] = [];
      for (let i = 0; i < pagesWithImages.length; i++) {
        const basePage = pagesWithImages[i];
        const pageCharacterIds = getPageCharacterIds(i);
        let basePrompt = `${basePage.imagePrompt}

CHARACTER LOCK (must match reference sheets exactly):
${getCharacterLockTextForPage(i)}

REFERENCE USAGE:
- If a FIRST reference image is provided, it is the PREVIOUS PAGE image for STYLE ONLY (palette/brush/lighting). Do NOT copy characters from it.
- All remaining reference images are CHARACTER SHEETS. Match character identity exactly.

PRIORITY: If any text conflicts with the references, follow the references for character appearance (species, fur color, clothing).
HARD RULE: Do NOT include any recurring characters unless explicitly mentioned on this page.` + SAFETY_SUFFIX;
        const seenFixes = new Set<string>();
        let bestImageUrl: string | null = null;
        let bestScore = -1;
        let bestIssues: string[] = [];

        for (let attempt = 1; attempt <= maxFrameRetry; attempt++) {
          setLoadingMessage(
            `Illustrating page ${basePage.pageNumber} (${attempt}/${maxFrameRetry})...`
          );

          // ✅ 关键：如果这里抛错（例如没 key / 401/403），以前你看不到错误
          // 现在 ErrorModal 会弹出来（因为 setError 后也能显示）
          const refsDeduped = buildRefsForPage(i);
          const imageUrl = await generateImage(basePrompt, refsDeduped);

          // Safety check (image)
          const imgSafe = await safetyCheckImage(imageUrl);
          if (!imgSafe.isSafe) {
            const reason = imgSafe.reasons.slice(0, 2).join('; ');
            basePrompt =
              basePrompt +
              `\nSAFETY REPAIR: Ensure child-safe content only. Avoid anything suggestive. (${reason || 'unsafe'})`;
            // 记录一下原因，方便占位显示
            basePage.imageError = `[Image safety blocked] ${reason || 'unsafe content'}`;
            continue;
          }

          const tmpPage: StoryPageEx = { ...basePage, imageUrl };

          // Identity check against reference character sheets (prevents drift like fur-color swaps).
          // IMPORTANT: only pass the characters needed for THIS page to avoid inducing extra cast members.
          const charsAll = extractedCharactersRef.current || [];
          const identitySheets = pageCharacterIds
            .map((id) => charsAll.find((c) => c.id === id))
            .filter(Boolean)
            .map((c) => ({
              name: c!.name || c!.id,
              visualDescription: c!.visualDescription,
              dataUrl: characterSheetMapRef.current[c!.id],
            }))
            .filter(
              (x): x is { name: string; visualDescription: string; dataUrl: string } =>
                Boolean(x.dataUrl)
            );

          const identityResult = await directorCheckIdentity({
            pageNumber: basePage.pageNumber,
            pageText: basePage.text,
            generatedImageUrl: imageUrl,
            characterSheets: identitySheets,
            style,
          });

          const frameResult = await directorCheckFrame(tmpPage);

          const combinedScore = Math.min(
            Number(frameResult.score ?? 0),
            Number(identityResult.score ?? 0)
          );
          // Put identity issues first so repairs prioritize character consistency.
          const combinedIssues = Array.from(
            new Set([
              ...(identityResult.issues ?? []),
              ...(frameResult.issues ?? []),
            ].map((s) => String(s)))
          );

          if (combinedScore > bestScore) {
            bestScore = combinedScore;
            bestImageUrl = imageUrl;
            bestIssues = combinedIssues;
          }

          if (combinedScore >= frameThreshold) {
            break;
          } else {
            if (combinedIssues && combinedIssues.length > 0) {
              const trimmedIssues = combinedIssues.slice(0, 4).join("; ");
              if (!seenFixes.has(trimmedIssues)) {
                seenFixes.add(trimmedIssues);
                basePrompt =
                  basePrompt +
                  `\nFIX (based on director): ${trimmedIssues}.` +
                  `\nBe literal: match the page text AND keep character identity exactly matching the reference sheets.` +
                  `\nDo not change fur colors/markings/clothing. Do not add extra objects or scenes not mentioned.`;
              } else {
                basePrompt =
                  basePrompt +
                  `\nBe more literal and accurate. Keep composition simple and clearly depict the stated action.` +
                  ` Keep all characters' appearances identical to the reference sheets.`;
              }
            }
          }
        }

        pagesWithImages[i] = {
          ...basePage,
          imageUrl: bestImageUrl ?? undefined,
          imageError:
            bestImageUrl
              ? undefined
              : (basePage.imageError ||
                  (bestIssues.length > 0
                    ? `Director issues: ${bestIssues.join("; ")}`
                    : "No image returned (check API key / model / quota).")),
        };

        if (bestIssues.length > 0) {
          frameIssuesAll.push(
            `Page ${basePage.pageNumber}: ${bestIssues.join("; ")}`
          );
        }

        setStorybookPages([...pagesWithImages]);
      }

      // Frame Director 总结
      const pagesReady = pagesWithImages.filter((p) => p.imageUrl);
      setFrameDirectorSummary(
        frameIssuesAll.length === 0
          ? `Director #1: ${pagesReady.length}/${pagesWithImages.length} pages generated. All pages passed frame-level checks or no major issues reported ✅`
          : `Director #1: Some pages needed adjustments. Issues observed:\n${frameIssuesAll.join(
              "\n"
            )}`
      );

      // 4) Sequence-level 闭环：检查整书一致性，必要时做一轮全局修复
      let finalSeqScore = 1;
      let finalSeqIssues: string[] = [];
      let finalSeqConsistent = true;

      for (let seqAttempt = 1; seqAttempt <= maxSequenceRetry + 1; seqAttempt++) {
        setLoadingMessage(
          seqAttempt === 1
            ? 'Director #2: checking global consistency across pages...'
            : `Director #2: re-checking after global repair (${seqAttempt}/${
                maxSequenceRetry + 1
              })...`
        );

        const currentPagesReady = pagesWithImages.filter((p) => p.imageUrl);
        // 如果一张图都没有，就别让 sequence director 再崩一次
        if (currentPagesReady.length === 0) {
          break;
        }

        const seqResult = await directorCheckSequence(currentPagesReady, style);
        finalSeqScore = seqResult.score;
        finalSeqIssues = seqResult.issues ?? [];
        finalSeqConsistent = seqResult.isConsistent;

        if (seqResult.score >= sequenceThreshold || seqAttempt > maxSequenceRetry) {
          break;
        }

        // sequence score 低：做一轮“全局修 prompt + 轻量重画”
        const globalHint = `IMPORTANT: Keep the main character and overall color palette consistent with earlier pages. Match the main character's species, approximate age, main clothing, and dominant colors from previous pages.`;

        const problemSet = new Set<number>(seqResult.problemPages ?? []);

        for (let i = 0; i < pagesWithImages.length; i++) {
          const basePage = pagesWithImages[i];
          const pageCharacterIds = getPageCharacterIds(i);

          if (problemSet.size > 0 && !problemSet.has(basePage.pageNumber)) {
            continue;
          }

          const basePrompt = `${basePage.imagePrompt}

CHARACTER LOCK (must match reference sheets exactly):
${getCharacterLockTextForPage(i)}

REFERENCE USAGE:
- If a FIRST reference image is provided, it is the PREVIOUS PAGE image for STYLE ONLY (palette/brush/lighting). Do NOT copy characters from it.
- All remaining reference images are CHARACTER SHEETS. Match character identity exactly.

PRIORITY: Follow the references for character appearance.
HARD RULE: Do NOT include any recurring characters unless explicitly mentioned on this page.` + SAFETY_SUFFIX + `
${globalHint}`;

          let bestImageUrl: string | null = null;
          let bestScore = -1;

          for (let attempt = 1; attempt <= 2; attempt++) {
            setLoadingMessage(
              `Global repair: re-illustrating page ${basePage.pageNumber} (${attempt}/2)...`
            );
            const refs = buildRefsForPage(i);
            const imageUrl = await generateImage(basePrompt, refs);

            const imgSafe = await safetyCheckImage(imageUrl);
            if (!imgSafe.isSafe) {
              continue;
            }

            const tmpPage: StoryPageEx = { ...basePage, imageUrl };
            const charsAll = extractedCharactersRef.current || [];
            const identitySheets = pageCharacterIds
              .map((id) => charsAll.find((c) => c.id === id))
              .filter(Boolean)
              .map((c) => ({
                name: c!.name || c!.id,
                visualDescription: c!.visualDescription,
                dataUrl: characterSheetMapRef.current[c!.id],
              }))
              .filter(
                (x): x is { name: string; visualDescription: string; dataUrl: string } =>
                  Boolean(x.dataUrl)
              );

            const identityResult = await directorCheckIdentity({
              pageNumber: basePage.pageNumber,
              pageText: basePage.text,
              generatedImageUrl: imageUrl,
              characterSheets: identitySheets,
              style,
            });

            const frameResult = await directorCheckFrame(tmpPage);

            const combinedScore = Math.min(
              Number(frameResult.score ?? 0),
              Number(identityResult.score ?? 0)
            );

            if (combinedScore > bestScore) {
              bestScore = combinedScore;
              bestImageUrl = imageUrl;
            }

            if (combinedScore >= frameThreshold) break;
          }

          pagesWithImages[i] = {
            ...basePage,
            imageUrl: bestImageUrl ?? basePage.imageUrl,
          };
        }

        setStorybookPages([...pagesWithImages]);
      }

      setSequenceDirectorSummary(
        `Director #2: ${
          finalSeqConsistent ? "sequence looks consistent ✅" : "sequence still has consistency issues ⚠️"
        } (score ${finalSeqScore.toFixed(2)}). ${
          finalSeqIssues.length ? "Issues: " + finalSeqIssues.join("; ") : ""
        }`
      );

      setLoadingMessage('Your storybook is ready!');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [
    storyText,
    imageFile,
    pageCount,
    style,
    frameThreshold,
    maxFrameRetry,
    sequenceThreshold,
    maxSequenceRetry,
  ]);

  // ========= UI =========

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-sans p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="text-center mb-8">
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-indigo-600">
            AI Cartoon Storybook Generator
          </h1>
          <p className="mt-4 text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
            Turn your stories into beautifully illustrated cartoon books with the magic of AI.
          </p>
        </header>

        <main>
          {/* ✅ 全局错误弹窗：不管现在在“表单页”还是“画册页”都能看到 */}
          {error && <ErrorModal error={error} onClose={() => setError(null)} />}

          {storybookPages.length === 0 && !isLoading && (
            <div className="max-w-3xl mx-auto bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-6 sm:p-8 transition-all">
              <div className="space-y-6">
                <div>
                  <label htmlFor="story" className="block text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">
                    Your Story
                  </label>
                  <textarea
                    id="story"
                    rows={10}
                    value={storyText}
                    onChange={(e) => setStoryText(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition duration-150 ease-in-out bg-gray-50 dark:bg-gray-700 placeholder-gray-400 dark:placeholder-gray-500"
                    placeholder="Once upon a time, in a land filled with candy clouds and sparkling rivers..."
                  />
                </div>

                {/* 页数输入 */}
                <div>
                  <label className="block text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">
                    Number of Pages (1–20)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={pageCount}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (Number.isNaN(val)) {
                        setPageCount(1);
                      } else {
                        setPageCount(Math.min(Math.max(val, 1), 20));
                      }
                    }}
                    className="w-32 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 bg-gray-50 dark:bg-gray-700 text-center"
                  />
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    The AI will adjust your story to match this many pages.
                  </p>
                </div>

                {/* 风格输入 */}
                <div>
                  <label className="block text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">
                    Style (for text & images)
                  </label>
                  <input
                    type="text"
                    value={style}
                    onChange={(e) => setStyle(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 bg-gray-50 dark:bg-gray-700"
                    placeholder='e.g. "whimsical, pastel, Studio Ghibli-like, cozy night-time vibe"'
                  />
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    This style will be used for the story tone and the illustration prompts.
                  </p>
                </div>

                {/* Advanced: loop controls */}
                <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40">
                  <div className="font-semibold text-gray-700 dark:text-gray-200 mb-2">
                    Advanced (Loop Controls)
                  </div>
                  <div className="flex flex-wrap gap-4">
                    <label className="text-sm text-gray-600 dark:text-gray-300">
                      Frame threshold
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        max={1}
                        value={frameThreshold}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          const clipped = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : DEFAULT_FRAME_THRESHOLD;
                          setFrameThreshold(clipped);
                        }}
                        className="ml-2 w-24 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700"
                      />
                    </label>

                    <label className="text-sm text-gray-600 dark:text-gray-300">
                      Max frame retry
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={maxFrameRetry}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          const clipped = Number.isFinite(v) ? Math.min(Math.max(v, 1), 10) : DEFAULT_MAX_FRAME_RETRY;
                          setMaxFrameRetry(clipped);
                        }}
                        className="ml-2 w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700"
                      />
                    </label>

                    <label className="text-sm text-gray-600 dark:text-gray-300">
                      Sequence threshold
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        max={1}
                        value={sequenceThreshold}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          const clipped = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : DEFAULT_SEQUENCE_THRESHOLD;
                          setSequenceThreshold(clipped);
                        }}
                        className="ml-2 w-24 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700"
                      />
                    </label>

                    <label className="text-sm text-gray-600 dark:text-gray-300">
                      Max sequence retry
                      <input
                        type="number"
                        min={0}
                        max={5}
                        value={maxSequenceRetry}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          const clipped = Number.isFinite(v) ? Math.min(Math.max(v, 0), 5) : DEFAULT_MAX_SEQUENCE_RETRY;
                          setMaxSequenceRetry(clipped);
                        }}
                        className="ml-2 w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700"
                      />
                    </label>
                  </div>
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Higher thresholds make the directors stricter; more retries improves quality but slows generation.
                  </p>
                </div>

                {safetyNote && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 border-l-4 border-amber-400 pl-3 whitespace-pre-line">
                    {safetyNote}
                  </p>
                )}

                {reviewFeedback && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 border-l-4 border-indigo-400 pl-3 whitespace-pre-line">
                    {reviewFeedback}
                  </p>
                )}

                {/* 图片上传 */}
                <div>
                  <label className="block text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">
                    Inspiration Image (Optional)
                  </label>
                  {!imagePreview ? (
                    <div
                      onClick={() => fileInputRef.current?.click()}
                      className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 dark:border-gray-600 border-dashed rounded-md cursor-pointer hover:border-indigo-500 dark:hover:border-indigo-400 transition-colors"
                    >
                      <div className="space-y-1 text-center">
                        <svg className="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48" aria-hidden="true">
                          <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <div className="flex text-sm text-gray-600 dark:text-gray-400">
                          <p className="pl-1">Upload a file</p>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-500">PNG, JPG, GIF up to 10MB</p>
                      </div>
                      <input
                        ref={fileInputRef}
                        id="file-upload"
                        name="file-upload"
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={handleImageChange}
                      />
                    </div>
                  ) : (
                    <div className="relative w-full max-w-sm mx-auto">
                      <img src={imagePreview} alt="Image preview" className="rounded-lg w-full h-auto shadow-md" />
                      <button
                        onClick={removeImage}
                        className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1.5 hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-transform transform hover:scale-110"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>

                {/* 这里保留也行，但主要靠 Modal 了 */}
                {error && <p className="text-red-500 text-center font-semibold whitespace-pre-line">{error}</p>}

                <button
                  onClick={handleGenerateClick}
                  disabled={isLoading}
                  className="w-full flex items-center justify-center gap-3 px-8 py-4 text-lg font-bold text-white bg-gradient-to-r from-purple-600 to-indigo-600 rounded-lg shadow-lg hover:shadow-xl transform hover:-translate-y-0.5 transition-all duration-300 ease-in-out focus:outline-none focus:ring-4 focus:ring-indigo-500 focus:ring-opacity-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <MagicWandIcon className="w-6 h-6" />
                  Create My Storybook
                </button>
              </div>
            </div>
          )}

          {isLoading && (
            <div className="max-w-3xl mx-auto">
              <Loader message={loadingMessage} />
            </div>
          )}

          {storybookPages.length > 0 && (
            <div>

{/* Reference Sheets (for consistency & paper) */}
{characterSheets.length > 0 && (
  <div className="max-w-6xl mx-auto mb-6">
    <div className="flex items-end justify-between mb-2">
      <div>
        <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">
          Reference Sheets
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          These anchors are fed to the image model to keep each character consistent across pages.
        </p>
      </div>
      <div className="flex items-center gap-3">
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {characterSheets.length} character sheet{characterSheets.length === 1 ? "" : "s"}
      </div>
      <button
        onClick={handleDownloadReferenceSheets}
        className="px-3 py-2 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
      >
        Download refs
      </button>
    </div>
    </div>

    <div className="flex gap-4 overflow-x-auto pb-3">
      {characterSheets.map((s) => (
        <div
          key={s.id}
          className="flex-shrink-0 w-56 bg-white dark:bg-gray-800 rounded-xl shadow border border-gray-200 dark:border-gray-700 overflow-hidden"
        >
          <div className="aspect-[4/3] bg-gray-200 dark:bg-gray-700">
            <img
              src={s.url}
              alt={`Character sheet: ${s.name}`}
              className="w-full h-full object-cover"
            />
          </div>
          <div className="p-3">
            <div className="font-semibold text-sm text-gray-800 dark:text-gray-100">
              {s.name}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {s.id}
            </div>
          </div>
        </div>
      ))}

      </div>
  </div>
)}

              {/* Director 反馈 */}
              <div className="max-w-3xl mx-auto mb-4 space-y-2">
                {frameDirectorSummary && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 border-l-4 border-emerald-400 pl-3 whitespace-pre-line">
                    {frameDirectorSummary}
                  </p>
                )}
                {sequenceDirectorSummary && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 border-l-4 border-blue-400 pl-3 whitespace-pre-line">
                    {sequenceDirectorSummary}
                  </p>
                )}
              </div>

              {/* 画册滑动展示 */}
              <div className="flex items-center gap-4 overflow-x-auto pb-4 storybook-container">
                {storybookPages.map((page, index) => (
                  <div
                    key={index}
                    className="flex-shrink-0 w-[90vw] sm:w-[60vw] md:w-[50vw] lg:w-[40vw] xl:w-[30vw] bg-white dark:bg-gray-800 rounded-lg shadow-xl overflow-hidden snap-center transform transition-all duration-500 hover:scale-105 hover:shadow-2xl"
                  >
                    <div className="aspect-[4/3] bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                      {page.imageUrl ? (
                        <img
                          src={page.imageUrl}
                          alt={`Illustration for page ${page.pageNumber}`}
                          className="w-full h-full object-cover"
                        />
                      ) : isLoading ? (
                        <div className="animate-pulse w-full h-full bg-gray-300 dark:bg-gray-600"></div>
                      ) : (
                        <div className="w-full h-full flex items-center justify-center p-4 text-center">
                          <div className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap">
                            <div className="font-semibold">Image unavailable</div>
                            <div className="mt-2 opacity-90">
                              {page.imageError || error || "No image returned from backend."}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="p-6">
                      <p className="text-gray-700 dark:text-gray-300 leading-relaxed">{page.text}</p>
                      <div className="text-right mt-4 text-sm font-bold text-indigo-500 dark:text-indigo-400">
                        Page {page.pageNumber}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="text-center mt-8 flex flex-wrap justify-center gap-4">
                <button
                  onClick={handleDownloadAll}
                  className="px-6 py-3 text-md font-semibold text-white bg-emerald-600 rounded-lg shadow-md hover:bg-emerald-700 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-opacity-75"
                >
                  Download All Pages
                </button>

                <button
                  onClick={resetApp}
                  className="px-6 py-3 text-md font-semibold text-white bg-indigo-600 rounded-lg shadow-md hover:bg-indigo-700 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-75"
                >
                  Create Another Story
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default App;
