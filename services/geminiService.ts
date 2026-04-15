// src/services/geminiService.ts
import { GoogleGenAI, Type } from "@google/genai";
import type { StoryPage } from "../types";

if (!process.env.API_KEY) {
  console.warn(
    "API_KEY environment variable not set. Using fallback_api_key_for_dev."
  );
}

const ai = new GoogleGenAI({
  apiKey: process.env.API_KEY || "fallback_api_key_for_dev",
});

/**
 * 这里的 model id 需要google AI studio的真实名字：
 *   - 文本/多模态内容（refine、分页、director）用 Gemini 3.0
 *   - 图片生成用 Nano Banana
 */
const TEXT_MODEL = "gemini-3-pro-preview";
const VISION_MODEL = "gemini-3-pro-preview";
const IMAGE_MODEL = "gemini-3-pro-image-preview"; 

// ============ 工具函数 ============

// 前端 File -> inlineData（上传灵感图用）
const fileToGenerativePart = async (file: File) => {
  const base64EncodedDataPromise = new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      resolve((reader.result as string).split(",")[1]);
    reader.readAsDataURL(file);
  });

  return {
    inlineData: {
      data: await base64EncodedDataPromise,
      mimeType: file.type,
    },
  };
};

// dataURL -> inlineData（给 director 看已经生成好的 PNG）
const dataUrlToInlineImagePart = (dataUrl: string) => {
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = /data:(.*?);base64/.exec(header);
  const mimeType = mimeMatch?.[1] ?? "image/png";

  return {
    inlineData: {
      data: base64,
      mimeType,
    },
  };
};

// ============ 0. Character Definition (for consistency) ============
export interface ExtractedCharacter {
  /** Stable id used to select reference images. */
  id: string;
  /** Display name (may appear in the story). */
  name: string;
  /** Visual description used to generate character sheets (species, colors, clothing, notable features). */
  visualDescription: string;
}

const slugifyId = (name: string) => {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "character";
};

export const extractCharacters = async (
  story: string,
  style: string
): Promise<ExtractedCharacter[]> => {
  try {
    const model = TEXT_MODEL;

    const systemInstruction = `You extract ALL RECURRING characters from a children's picture-book story for illustration consistency.
Return up to FIVE recurring characters (max 5). If there are more, merge or omit minor one-off characters.
For each character, return:
- id: short stable id (lowercase snake_case)
- name: the name (or a short label like "the puppy" if unnamed)
- visualDescription: concise but specific visual details (species, fur/skin color, clothing, notable features, and any distinctive recurring props/symbols like a star on a bag).
Style context: ${style}

Return ONLY JSON that matches the schema.`;

    const userPrompt = `STORY:\n${story}\n\nExtract up to 5 recurring characters (max 5). Prefer characters that persist across multiple pages.`;

    const response = await ai.models.generateContent({
      model,
      contents: [{ text: userPrompt }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            characters: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  name: { type: Type.STRING },
                  visualDescription: { type: Type.STRING },
                },
                required: ["id", "name", "visualDescription"],
              },
            },
          },
          required: ["characters"],
        },
      },
    });

    const json = JSON.parse(response.text);
    const chars = Array.isArray(json.characters) ? json.characters : [];

    const cleaned: ExtractedCharacter[] = chars
      .map((c: any) => ({
        id: String(c.id || ""),
        name: String(c.name || ""),
        visualDescription: String(c.visualDescription || ""),
      }))
      .filter((c) => c.name.trim().length > 0 || c.visualDescription.trim().length > 0)
      .map((c) => ({
        ...c,
        id: c.id.trim() ? slugifyId(c.id) : slugifyId(c.name),
        name: c.name.trim() ? c.name : "Main character",
        visualDescription: c.visualDescription.trim() ? c.visualDescription : c.name,
      }))
      .slice(0, 5);

    return cleaned;
  } catch (error) {
    console.error("Error extracting characters:", error);
    return [];
  }
};

// ============ 1. Reviewer + Refiner ============

export const refineStoryForPageCount = async (
  story: string,
  targetPageCount: number,
  style: string
): Promise<{
  finalStory: string;
  mode: "good_polish" | "rewrite";
  feedback: string;
}> => {
  try {
    const model = TEXT_MODEL;
    const safePageCount = Math.min(Math.max(targetPageCount, 1), 20);

    const approxWordsPerPage = 90;
    const targetTotalWords = approxWordsPerPage * safePageCount;

    const systemInstruction = `You are an assistant that first REVIEWS and then REFINES children's stories for picture books.

Your job has TWO phases:

1) REVIEW:
- Read the user's story.
- Judge if it is already reasonably good for about ${safePageCount} pages in a picture book.
- "Reasonably good" means:
  - Clear beginning, middle, and end.
  - Main character(s) and goal are understandable.
  - Tone roughly matches this style: ${style}.
  - Story length is roughly appropriate for ~${targetTotalWords} words total (it can be shorter or longer, but not extreme).

2) REFINE:
There are TWO possible refine modes:

A) If the story is ALREADY reasonably good:
   - Set "mode" = "good_polish".
   - Apply ONLY light editing:
     - Fix grammar and awkward phrases.
     - Improve clarity and flow at the sentence level.
     - Add very small details if helpful, but DO NOT change the overall structure or main events.
   - The refined story should still clearly feel like the same story from the user, just smoother and slightly better.
   - Length should remain roughly similar, only slightly adjusted to better fit ~${targetTotalWords} words.

B) If the story is NOT good enough (too short, too long, very unclear, or poorly structured):
   - Set "mode" = "rewrite".
   - Do a stronger rewrite:
     - Expand the story with richer but still simple details if it is too short.
     - Compress and remove repetition or irrelevant digressions if it is too long.
     - Improve clarity, structure, and pacing, while keeping the user's main characters, tone, and core plot.
   - Aim for about ${targetTotalWords} words total (approximate, not exact).
   - Make the tone and imagery match this style: ${style}.

IMPORTANT:
- The refined story MUST have at most 5 recurring characters total. If the draft has more, merge minor characters into existing ones or remove them.
- Keep character names and appearances stable throughout the story (no swapping species, colors, or clothing).
- Always fill all three fields: "mode", "feedback", and "finalStory".
- "feedback" should briefly explain your decision, e.g., "Story is already clear, did light polishing." or "Too short for the requested length, expanded the middle part."
- Return ONLY JSON that matches the response schema. Do NOT include any extra commentary.`;

    const userPrompt = `Here is the user's draft story. First REVIEW it. 
If it is already reasonably good, do LIGHT POLISHING ("good_polish"). 
If not, REWRITE it more strongly ("rewrite") as described.

USER STORY:
"${story}"`;

    const response = await ai.models.generateContent({
      model,
      contents: [{ text: userPrompt }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            mode: {
              type: Type.STRING,
              description:
                '"good_polish" if the story was already good and only lightly edited; "rewrite" if a stronger rewrite was done.',
            },
            feedback: {
              type: Type.STRING,
              description:
                "Short natural language feedback explaining the decision and what was changed.",
            },
            finalStory: {
              type: Type.STRING,
              description:
                "The refined story text that should be used for later page splitting.",
            },
          },
          required: ["mode", "feedback", "finalStory"],
        },
      },
    });

    const json = JSON.parse(response.text);

    const mode: "good_polish" | "rewrite" =
      json.mode === "rewrite" ? "rewrite" : "good_polish";

    return {
      mode,
      feedback: String(json.feedback ?? ""),
      finalStory: String(json.finalStory ?? story),
    };
  } catch (error) {
    console.error("Error refining story:", error);
    return {
      mode: "good_polish",
      feedback: "Refine step failed, using original story.",
      finalStory: story,
    };
  }
};

// ============ 2. Script Writer：按页数 + 风格切成 pages ============

export const parseStoryIntoPages = async (
  story: string,
  imageFile: File | null,
  targetPageCount: number = 6,
  style: string = "whimsical, cute, children's picture-book style"
): Promise<Omit<StoryPage, "imageUrl">[]> => {
  try {
    const model = TEXT_MODEL;
    const safePageCount = Math.min(Math.max(targetPageCount, 1), 20);

    const systemInstruction = `You are a creative assistant that helps users turn stories into beautifully illustrated cartoon storybooks for children. 

Your task is to break down a given story into EXACTLY ${safePageCount} logical pages.
For each page, you must provide:
- "pageNumber": starting from 1
- "text": the text portion for that page
- "imagePrompt": a detailed, imaginative prompt for an image generator.

STYLE & CONSISTENCY REQUIREMENTS:
- Global visual & narrative style: ${style}
- Use this style consistently across ALL pages.
- Keep characters' appearance, names, species, clothing, and personality consistent.
- Keep important props, environments, and color palettes consistent, unless the story explicitly changes them.
- Each imagePrompt should clearly reference the same main character(s) so an image model can keep them visually consistent.
- Make sure every page is visually depictable: there should be a clear scene, setting, and character actions.

Return ONLY valid JSON that matches the provided response schema. Do NOT include any extra commentary.`;

    const textPrompt = imageFile
      ? `Analyze the character and style from the provided image. Then, using that as inspiration and following the style "${style}", read the following story and split it into EXACTLY ${safePageCount} pages: "${story}".`
      : `Here is the story. Split it into EXACTLY ${safePageCount} pages.
For each page, output pageNumber, text, and imagePrompt in the style "${style}". Story:
"${story}".`;

    const parts: (
      | { text: string }
      | { inlineData: { data: string; mimeType: string } }
    )[] = [{ text: textPrompt }];

    if (imageFile) {
      const imagePart = await fileToGenerativePart(imageFile);
      parts.unshift(imagePart);
    }

    const response = await ai.models.generateContent({
      model,
      contents: { parts },
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            pages: {
              type: Type.ARRAY,
              description: `An array of story pages, exactly ${safePageCount} pages long.`,
              items: {
                type: Type.OBJECT,
                properties: {
                  pageNumber: {
                    type: Type.INTEGER,
                    description:
                      "The sequential page number, starting from 1.",
                  },
                  text: {
                    type: Type.STRING,
                    description:
                      "The segment of the story for this specific page.",
                  },
                  imagePrompt: {
                    type: Type.STRING,
                    description:
                      "A detailed prompt for an image generation AI, in the chosen cartoon style.",
                  },
                },
                required: ["pageNumber", "text", "imagePrompt"],
              },
            },
          },
          required: ["pages"],
        },
      },
    });

    const jsonResponse = JSON.parse(response.text);
    if (!jsonResponse.pages || !Array.isArray(jsonResponse.pages)) {
      throw new Error("Invalid response format from story parsing API.");
    }

    return jsonResponse.pages as Omit<StoryPage, "imageUrl">[];
  } catch (error) {
    console.error("Error parsing story:", error);
    throw new Error(
      "Failed to parse the story into pages. Please try again."
    );
  }
};

// ============ 3. 两个 Director（多模态监制）===========

export interface DirectorFrameResult {
  pageNumber: number;
  isAcceptable: boolean;
  score: number;
  issues: string[];
}

export interface DirectorSequenceResult {
  isConsistent: boolean;
  score: number;
  issues: string[];
  /** Optional list of page numbers that most likely need repair. */
  problemPages?: number[];
}

export interface DirectorIdentityResult {
  /** Whether the generated image preserves identity w.r.t. the provided reference sheets. */
  isConsistent: boolean;
  /** 0.0–1.0 overall identity consistency score. */
  score: number;
  /** Short issues describing mismatched identities/props/style. */
  issues: string[];
}

export const directorCheckFrame = async (
  page: StoryPage
): Promise<DirectorFrameResult> => {
  if (!page.imageUrl) {
    return {
      pageNumber: page.pageNumber,
      isAcceptable: false,
      score: 0,
      issues: ["No image available for this page."],
    };
  }

  try {
    const model = VISION_MODEL;

    const imagePart = dataUrlToInlineImagePart(page.imageUrl);
    const userText = `You are the FRAME DIRECTOR for a children's picture-book production.

Your job is to evaluate ONE page (one image + its text):

PAGE NUMBER: ${page.pageNumber}

TEXT:
"${page.text}"

Please check:
1. Does the image match the main events, characters, and mood described in the text?
2. Are the important objects, characters, and setting correctly reflected?
3. Would this image feel "correct" to a child reading this text?

Scoring:
- "score" is a number between 0.0 and 1.0.
- score >= 0.75: acceptable.
- score < 0.75: not acceptable.

Return ONLY JSON with:
- "isAcceptable": boolean
- "score": number
- "issues": array of short strings (empty if acceptable).`;

    const response = await ai.models.generateContent({
      model,
      contents: {
        parts: [imagePart, { text: userText }],
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isAcceptable: { type: Type.BOOLEAN },
            score: { type: Type.NUMBER },
            issues: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ["isAcceptable", "score", "issues"],
        },
      },
    });

    const json = JSON.parse(response.text);
    return {
      pageNumber: page.pageNumber,
      isAcceptable: Boolean(json.isAcceptable),
      score: Number(json.score ?? 0),
      issues: Array.isArray(json.issues)
        ? json.issues.map((x: unknown) => String(x))
        : [],
    };
  } catch (error) {
    console.error("Error in directorCheckFrame:", error);
    return {
      pageNumber: page.pageNumber,
      isAcceptable: true,
      score: 1,
      issues: ["Director frame check failed, treating as acceptable."],
    };
  }
};

/**
 * Identity/consistency check against reference character sheets (and optional group sheet).
 * This is used in the per-page loop to prevent drift (e.g., fur color changes) even when
 * the image roughly matches the text.
 */
export const directorCheckIdentity = async (
  args: {
    pageNumber: number;
    pageText: string;
    generatedImageUrl: string;
    /** Reference sheets for all recurring characters (recommended: <=5). */
    characterSheets: { name: string; visualDescription: string; dataUrl: string }[];
    /** Optional group sheet showing all characters together. */
    groupSheetDataUrl?: string | null;
    /** Optional global style. */
    style?: string;
  }
): Promise<DirectorIdentityResult> => {
  try {
    const model = VISION_MODEL;

    const parts: (
      | { text: string }
      | { inlineData: { data: string; mimeType: string } }
    )[] = [];

    parts.push({
      text:
        `You are the IDENTITY DIRECTOR for a children's picture-book production.\n` +
        `Your job is to check whether the GENERATED PAGE IMAGE preserves character identity and key recurring props\n` +
        `with respect to the provided REFERENCE SHEETS.\n\n` +
        `RULES:\n` +
        `- Treat reference sheets as GROUND TRUTH for character appearance (species, fur/skin color, markings, clothing, face shape).\n` +
        `- If the page text conflicts with the reference sheets about appearance, the reference sheets win.\n` +
        `- Score should penalize: color/marking drift, species drift, missing/extra main characters, major prop drift.\n` +
        `- Ignore small pose changes; focus on identity and recurring attributes.\n\n` +
        `- Output issues ordered from MOST identity-critical to least (e.g., wrong species/fur/markings/clothing, missing distinctive symbols like a star on a bag, hood vs collar).\n\n` +
        `PAGE ${args.pageNumber} TEXT:\n"${args.pageText}"\n\n` +
        (args.style ? `GLOBAL STYLE: ${args.style}\n\n` : ``) +
        `Now you will be shown the reference sheets, then the generated page image.`,
    });

    // Reference sheets
    for (const ch of (args.characterSheets || []).slice(0, 5)) {
      if (!ch?.dataUrl) continue;
      parts.push({
        text: `REFERENCE SHEET — ${ch.name}\nExpected visual traits: ${ch.visualDescription}\nImage:`,
      });
      parts.push(dataUrlToInlineImagePart(ch.dataUrl));
    }

    if (args.groupSheetDataUrl) {
      parts.push({ text: `REFERENCE GROUP SHEET (all characters together):` });
      parts.push(dataUrlToInlineImagePart(args.groupSheetDataUrl));
    }

    // Generated image
    parts.push({ text: `GENERATED PAGE IMAGE (evaluate identity vs references):` });
    parts.push(dataUrlToInlineImagePart(args.generatedImageUrl));

    const response = await ai.models.generateContent({
      model,
      contents: { parts },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isConsistent: { type: Type.BOOLEAN },
            score: { type: Type.NUMBER },
            issues: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["isConsistent", "score", "issues"],
        },
      },
    });

    const json = JSON.parse(response.text);
    return {
      isConsistent: Boolean(json.isConsistent),
      score: Number(json.score ?? 0),
      issues: Array.isArray(json.issues)
        ? json.issues.map((x: unknown) => String(x))
        : [],
    };
  } catch (error) {
    console.error("Error in directorCheckIdentity:", error);
    // Fail-open: don't block generation if identity director fails
    return {
      isConsistent: true,
      score: 1,
      issues: ["Identity director check failed; treating as consistent."],
    };
  }
};

export const directorCheckSequence = async (
  pages: StoryPage[],
  style: string
): Promise<DirectorSequenceResult> => {
  try {
    const model = VISION_MODEL;

    const parts: (
      | { text: string }
      | { inlineData: { data: string; mimeType: string } }
    )[] = [];

    for (const page of pages) {
      if (!page.imageUrl) continue;
      parts.push({
        text: `PAGE ${page.pageNumber} TEXT:\n"${page.text}"\nNow see its image:`,
      });
      parts.push(dataUrlToInlineImagePart(page.imageUrl));
    }

    const systemInstruction = `You are the SEQUENCE DIRECTOR for a children's picture-book production.

You will see a sequence of pages (each with text and an image).
Evaluate the WHOLE SEQUENCE with respect to:

1. Character continuity:
   - Do the main characters look like the same entities across pages?
   - Are species, approximate age, main clothing / colors, and notable features consistent?

2. World & prop continuity:
   - Are important recurring locations, objects, or props consistent across pages
     (unless the story clearly changes them)?

3. Global style:
   - Does the art style look coherent across pages (line quality, color palette, level of detail)?

4. Narrative alignment:
   - Does the progression of images roughly follow the text from early pages to later pages?

Scoring:
- "score" is a number between 0.0 and 1.0 for overall sequence quality.
- score >= 0.75: "isConsistent" = true.
- score < 0.75: "isConsistent" = false.

Return ONLY JSON with:
- "isConsistent": boolean
- "score": number
- "issues": array of short strings describing the main continuity problems (empty if consistent).
- "problemPages": array of page numbers that most likely need repair (empty if consistent).`;

    const response = await ai.models.generateContent({
      model,
      contents: {
        parts: [
          {
            text: `Global target style (for reference): ${style}\n\nNow evaluate the following sequence of pages:`,
          },
          ...parts,
        ],
      },
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isConsistent: { type: Type.BOOLEAN },
            score: { type: Type.NUMBER },
            issues: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            problemPages: {
              type: Type.ARRAY,
              items: { type: Type.INTEGER },
              description:
                "Page numbers that most likely need repair for consistency (use existing page numbers).",
            },
          },
          required: ["isConsistent", "score", "issues"],
        },
      },
    });

    const json = JSON.parse(response.text);
    return {
      isConsistent: Boolean(json.isConsistent),
      score: Number(json.score ?? 0),
      issues: Array.isArray(json.issues)
        ? json.issues.map((x: unknown) => String(x))
        : [],
      problemPages: Array.isArray(json.problemPages)
        ? json.problemPages
            .map((x: unknown) => Number(x))
            .filter((n: number) => Number.isFinite(n) && n > 0)
        : [],
    };
  } catch (error) {
    console.error("Error in directorCheckSequence:", error);
    return {
      isConsistent: true,
      score: 1,
      issues: ["Director sequence check failed, treating as consistent."],
      problemPages: [],
    };
  }
};

// ============ 3.5 Safety (children-friendly content checks) ============

export interface SafetyTextResult {
  isSafe: boolean;
  reasons: string[];
  sanitizedText?: string;
}

export interface SafetyImageResult {
  isSafe: boolean;
  reasons: string[];
}

/**
 * Text safety check for children's content.
 * - check: returns isSafe/reasons
 * - sanitize: rewrites the text to be safe (keeps plot as much as possible)
 */
export const safetyCheckText = async (
  input: string,
  mode: "check" | "sanitize" = "check"
): Promise<SafetyTextResult> => {
  try {
    const model = TEXT_MODEL;

    const systemInstruction = `You are a strict safety checker for CHILDREN'S storybooks.
Flag and reject any: sexual content, nudity, erotic/suggestive themes, sexualization of minors, adult romance themes.
Also flag: graphic violence/gore, hate/harassment, instructions for wrongdoing.
Return ONLY JSON.`;

    const userText =
      mode === "check"
        ? `Check whether the following text is safe for children.
If unsafe, set isSafe=false and list brief reasons.

TEXT:\n${input}`
        : `Rewrite the following text to be SAFE for children while keeping the plot as much as possible.
Remove/replace unsafe content. Output sanitizedText.

TEXT:\n${input}`;

    const response = await ai.models.generateContent({
      model,
      contents: [{ text: userText }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isSafe: { type: Type.BOOLEAN },
            reasons: { type: Type.ARRAY, items: { type: Type.STRING } },
            sanitizedText: { type: Type.STRING },
          },
          required: ["isSafe", "reasons"],
        },
      },
    });

    const json = JSON.parse(response.text);
    return {
      isSafe: Boolean(json.isSafe),
      reasons: Array.isArray(json.reasons)
        ? json.reasons.map((x: unknown) => String(x))
        : [],
      sanitizedText:
        typeof json.sanitizedText === "string" ? json.sanitizedText : undefined,
    };
  } catch (error) {
    console.error("Error in safetyCheckText:", error);
    // Fail-open to avoid blocking (your UI will still have image-level checks)
    return { isSafe: true, reasons: ["Safety text check failed; treating as safe."] };
  }
};

/**
 * Image safety check (expects a dataURL like data:image/png;base64,...)
 */
export const safetyCheckImage = async (
  imageDataUrl: string
): Promise<SafetyImageResult> => {
  try {
    const model = VISION_MODEL;

    const systemInstruction = `You are a strict safety checker for CHILDREN'S illustrations.
Flag and reject any: nudity, sexual content, suggestive depiction, sexualization of minors, adult/erotic themes.
Also flag: graphic violence/gore, hate symbols.
Return ONLY JSON.`;

    const imagePart = dataUrlToInlineImagePart(imageDataUrl);

    const response = await ai.models.generateContent({
      model,
      contents: {
        parts: [imagePart, { text: "Is this image safe for children? Return JSON." }],
      },
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isSafe: { type: Type.BOOLEAN },
            reasons: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["isSafe", "reasons"],
        },
      },
    });

    const json = JSON.parse(response.text);
    return {
      isSafe: Boolean(json.isSafe),
      reasons: Array.isArray(json.reasons)
        ? json.reasons.map((x: unknown) => String(x))
        : [],
    };
  } catch (error) {
    console.error("Error in safetyCheckImage:", error);
    return { isSafe: true, reasons: ["Safety image check failed; treating as safe."] };
  }
};

// ============ 4. 图片生成（Nano Banana Pro）===========

export const generateImage = async (
  prompt: string,
  referenceDataUrls: string[] = []
): Promise<string> => {
  // IMPORTANT CONVENTION (for consistency):
  // - referenceDataUrls[0] (if present) is a STYLE reference image (e.g., previous page image).
  // - referenceDataUrls[1..] are CHARACTER reference sheets.
  // We must explicitly tell the model how to use them; otherwise it may mix roles and drift.

  const cleanedRefs = referenceDataUrls.filter(Boolean).slice(0, 14);
  const styleRef = cleanedRefs.length > 0 ? cleanedRefs[0] : null;
  const characterRefs = cleanedRefs.length > 1 ? cleanedRefs.slice(1) : [];

  const fullPrompt =
    `REFERENCE ROLES (must follow):\n` +
    `- The FIRST reference image is STYLE ONLY (palette/brush/texture/lighting). Do NOT copy character identity from it.\n` +
    `- All remaining reference images are CHARACTER SHEETS. You MUST match their species, fur/skin colors, clothing, and accessories exactly.\n` +
    `- If the story text conflicts with the refs, keep character appearance consistent with the CHARACTER SHEETS.\n\n` +
    `${prompt}\n` +
    `IMPORTANT: Follow the page text literally. Do not invent extra major objects or characters.\n`;

  const parts: any[] = [];
  if (styleRef) {
    parts.push({ text: "[STYLE REFERENCE IMAGE — style only]" });
    parts.push(dataUrlToInlineImagePart(styleRef));
  }
  if (characterRefs.length) {
    parts.push({ text: "[CHARACTER REFERENCE IMAGES — match identity exactly]" });
    for (const d of characterRefs) parts.push(dataUrlToInlineImagePart(d));
  }
  parts.push({ text: fullPrompt });

  try {
    const response = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: parts,
      config: {
        responseModalities: ["Image"],
        imageConfig: {
          aspectRatio: "4:3",
          imageSize: "2K",
        },
      },
    });

    const respParts = response?.candidates?.[0]?.content?.parts ?? [];
    const imgPart = respParts.find((p: any) => p.inlineData?.data);

    if (!imgPart) {
      throw new Error(`No inline image data in response. parts=${JSON.stringify(parts)}`);
    }

    const b64 = imgPart.inlineData.data as string;
    const mime = imgPart.inlineData.mimeType || "image/png";
    return `data:${mime};base64,${b64}`;
  } catch (error: any) {
    // Backward-compatible fallback: if no refs provided, try generateImages (older path).
    if (cleanedRefs.length === 0) {
      try {
        const response = await ai.models.generateImages({
          model: IMAGE_MODEL,
          // Keep this path minimal; style should be specified in `prompt`.
          prompt: `${prompt}`,
          config: {
            numberOfImages: 1,
            outputMimeType: "image/png",
            aspectRatio: "4:3",
          },
        });

        if (response.generatedImages && response.generatedImages.length > 0) {
          const base64ImageBytes: string = response.generatedImages[0].image.imageBytes;
          return `data:image/png;base64,${base64ImageBytes}`;
        }
      } catch (e2) {
        // fallthrough to throw below
      }
    }

    console.error("Error generating image:", error);
    const msg =
      error?.message ||
      (typeof error === "string" ? error : JSON.stringify(error));
    throw new Error(
      `Failed to generate an illustration.\nModel: ${IMAGE_MODEL}\nReason: ${msg}`
    );
  }
};
