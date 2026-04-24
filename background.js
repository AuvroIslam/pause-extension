// Pause Extension v2 — Service Worker
// Handles AI API calls with automatic fallback: Groq → Mistral → DeepSeek

const PROFILE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Proxy endpoint ───────────────────────────────────────────────────────────
// All AI calls route through the Vercel proxy so no API keys are stored in the extension.
// Update PROXY_URL after deploying the /proxy folder to Vercel.
const PROXY_URL = 'https://pause-proxy.vercel.app/api/ai';

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ modelProfiles: {} });
});

// Keep service worker alive during active sessions — MV3 workers terminate after 30s idle,
// which closes the message port and causes content script requests to hang silently.
// Any message (including PING) resets the idle timer.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'PING') return; // handled, keeps SW awake
});

// ─── Storage helpers ─────────────────────────────────────────────────────────

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

// ─── HTTP layer ───────────────────────────────────────────────────────────────

async function fetchWithFallback(messages, extraParams = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  let response;
  try {
    response = await fetch(PROXY_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, extraParams }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('TIMEOUT');
    throw new Error('NETWORK');
  }
  clearTimeout(timer);

  if (response.status === 429) throw new Error('RATE_LIMIT');
  if (response.status >= 500)  throw new Error('SERVER_ERROR');
  if (!response.ok)            throw new Error(`HTTP_${response.status}`);

  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.content ?? '';
}

// ─── Domain detection ────────────────────────────────────────────────────────
// Detects the prompt's domain so we can apply appropriate temperature and
// domain-specific construction rules in the improved prompt.

function detectDomain(text) {
  const t = (text || '').toLowerCase();

  // Communication checked FIRST — specific nouns (email, letter, memo) beat generic verbs like "write"
  if (/\b(email|letter|cover letter|resignation|memo|announcement|apology|reply|respond to|follow.?up|message to|write to|slack message|linkedin|cold outreach|proposal to|recommendation letter)\b/.test(t)) {
    return { domain: 'communication', temperature: 0.35 };
  }

  // Creative — check before coding because "write a story/poem" starts with "write"
  if (/\b(story|poem|essay|blog post|article|creative|fiction|narrative|character|plot|chapter|screenplay|song|lyrics|haiku|sonnet|short story|write about|write a (poem|story|essay|song|letter to santa))\b/.test(t)) {
    return { domain: 'creative', temperature: 0.5 };
  }

  // Debugging — very specific signals, safe to check anywhere
  if (/\b(fix (this|the|my|a) (bug|error|issue|code|function)|debug|exception|traceback|stack trace|not working|failing|broken|undefined is not|null pointer|type error|syntax error|runtime error|why (does|is|isn't|doesn't)|error:|Error:)\b/.test(t)) {
    return { domain: 'debugging', temperature: 0.15 };
  }

  // Coding — only after communication/creative are ruled out; requires technical signals alongside action verbs
  if (/\b(function|class|component|api|endpoint|refactor|optimize|implement|code|script|program|algorithm|database|query|backend|frontend|full.?stack|build (a |an |the )?(app|website|tool|bot|cli|server|api|component|feature)|create (a |an |the )?(app|website|tool|bot|script|function|class|api)|develop)\b/.test(t)) {
    return { domain: 'coding', temperature: 0.15 };
  }

  // Planning
  if (/\b(plan|strategy|roadmap|steps to|process for|workflow|framework|approach|checklist|outline|how (should|do) i|action items)\b/.test(t)) {
    return { domain: 'planning', temperature: 0.3 };
  }

  // Research / explanation
  if (/\b(explain|what is|what are|how does|how do|compare|summarize|analyze|research|review|difference between|pros and cons|overview of|define|tell me about|give me an overview)\b/.test(t)) {
    return { domain: 'research', temperature: 0.2 };
  }

  return { domain: 'general', temperature: 0.25 };
}

const DOMAIN_GUIDANCE = {
  debugging: `This is a DEBUGGING prompt.
- Preserve exact error messages, code snippets, and stack traces verbatim.
- The improved prompt should ask for: root cause identification, step-by-step diagnosis, and a concrete fix with explanation.
- Do not simplify technical details — precision is critical here.`,

  coding: `This is a CODE GENERATION prompt.
- Preserve the exact language, framework, and architectural requirements.
- The improved prompt should specify: language/version, coding style, error handling expectations, whether tests are needed, and output format (complete file vs snippet).
- Do not add features or requirements the user didn't mention.`,

  creative: `This is a CREATIVE WRITING prompt.
- Preserve the creative freedom — do not over-constrain the output.
- The improved prompt should clarify: genre/form, tone/mood, POV, target length, and any stylistic preferences the user stated.
- Leave intentional ambiguity — good creative prompts suggest, they don't dictate every detail.`,

  communication: `This is a COMMUNICATION/DRAFTING prompt.
- The improved prompt should specify: recipient relationship, desired tone (formal/casual/warm), key message to convey, desired length, and any specific call-to-action.
- Preserve the user's voice — don't make it sound like a template.`,

  planning: `This is a PLANNING/STRATEGY prompt.
- The improved prompt should specify: the goal/outcome, constraints (time, budget, resources), stakeholders, and desired output format (numbered steps, flowchart description, table).
- Include the specific context the user provided about their situation.`,

  research: `This is a RESEARCH/EXPLANATION prompt.
- The improved prompt should specify: audience expertise level, desired depth (quick overview vs comprehensive analysis), preferred format (bullet summary, essay, comparison table), and any scope constraints.
- If the user wants citations or sources, include that explicitly.`,

  general: `This is a GENERAL prompt.
- Structure it clearly with: a role/context framing, a precise task statement, the relevant context the user provided, and an explicit output format.`,
};

// ─── Input sanitisation ──────────────────────────────────────────────────────

function sanitizeInput(str, maxLen) {
  return String(str || '').trim().slice(0, maxLen);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleCheckApiKey(sendResponse) {
  // With hardcoded keys in APIS, we always have a key. Kept for compatibility.
  sendResponse({ ok: true, hasKey: true });
}

async function handleSaveApiKey(msg, sendResponse) {
  // Store a user-supplied override key (used if all hardcoded keys expire)
  await storageSet({ userGroqKey: sanitizeInput(msg.key, 200) });
  sendResponse({ ok: true });
}

async function handleGetOrSetModelProfile(msg, sendResponse) {
  const { modelProfiles = {} } = await storageGet('modelProfiles');
  const { hostname, profileData } = msg;

  if (profileData !== null) {
    modelProfiles[hostname] = { ...profileData, cachedAt: Date.now() };
    await storageSet({ modelProfiles });
    sendResponse({ ok: true, profile: modelProfiles[hostname] });
    return;
  }

  const cached = modelProfiles[hostname];
  if (cached && Date.now() - cached.cachedAt < PROFILE_TTL) {
    sendResponse({ ok: true, profile: cached });
  } else {
    sendResponse({ ok: true, profile: null });
  }
}

// Shared system prompt for the adaptive question approach (AT-CoT, SIGIR 2025).
// Called once per question — each call receives the full Q&A history so far,
// meaning every new question is informed by every previous answer.
function buildNextQuestionSystemPrompt(domain) {
  return `You are an expert prompt analyst generating ONE adaptive clarifying question at a time.

━━━ YOUR ROLE ━━━
You receive a user's draft AI prompt and all clarifying questions + answers exchanged so far.
Your job: decide whether another question is needed, and if so, generate exactly ONE question that:
  • Targets a gap NOT already resolved by previous answers
  • Logically follows from what the user already revealed
  • Would meaningfully change the final AI output if answered

━━━ AMBIGUITY CHECKLIST (scan before deciding) ━━━
WHO  — audience, recipient, subject, perspective
WHAT — exact task, key details, specific constraints, missing content
HOW  — output format, tone/style, length, structure
WHY  — purpose, end-use, background context
SCOPE — too broad / too narrow, temporal/geographic limits

━━━ DOMAIN: ${domain} ━━━
${domain === 'debugging'     ? 'Prioritise: exact error/symptom → environment (lang+version+OS) → what was tried. Stop after those 3 unless something unusual is missing.' : ''}
${domain === 'coding'        ? 'MANDATORY FIRST CHECK: Does the prompt mention a specific language, framework, or tech stack (e.g. Python, React, Node, Java, Flutter)? If NOT, your FIRST question MUST be about the stack — ask which language/framework/platform they are using. Only proceed to other gaps after stack is known. Never ask about language if the answer already implies it (e.g. "React Native" implies JavaScript/TypeScript, "Django" implies Python).' : ''}
${domain === 'creative'      ? 'Prioritise: tone/register → target reader → length/form → stylistic reference. Do not ask about style after tone is already answered.' : ''}
${domain === 'communication' ? 'MANDATORY CHECKS IN ORDER: (1) Does the prompt say who the SENDER is? (e.g. university student, office employee, school student, freelancer, teacher, client) — if NOT stated, FIRST question MUST be "Who are you in this situation?" with chips: University student, Office professional, School student, Freelancer. (2) Does it say the relationship to the recipient? If not → ask that next. (3) Desired tone? If not → ask. Never skip identity if missing — it changes the entire voice and register of the communication.' : ''}
${domain === 'planning'      ? 'Prioritise: hard constraints (time/budget) → audience expertise → output structure.' : ''}
${domain === 'research'      ? 'Prioritise: audience knowledge level → depth (overview vs deep) → output format.' : ''}
${domain === 'general'       ? 'Prioritise: end-use purpose → audience → format and length → constraints.' : ''}

━━━ STOP ASKING IF ━━━
• The gap was already resolved by a previous answer (directly or by implication)
• You have asked 5 questions already (hard maximum)
• The prompt + answers are now specific enough to produce a great output
→ In these cases return: {"done": true}

━━━ QUESTION QUALITY RULES ━━━
✓ Must reference something SPECIFIC in the draft (not be generically applicable to any prompt)
✓ Must be clearly answerable in one sentence
✓ Must NOT overlap with or repeat any previous question
✓ Must follow logically — if Q1 revealed the platform, Q2 must not re-open that dimension
✓ Phrased naturally, not like a form field label

✗ Bad: "What programming language should be used?" after user said "React Native" (implies JS/TS)
✓ Good: "Should the app support offline mode or is a network connection always available?"

━━━ CHIP SUGGESTIONS ━━━
Generate exactly 3–4 concrete answer chips (max 7 words each).
• Must be direct answers derived from THIS prompt's context
• Set "multiSelect": true only when multiple chips are simultaneously valid
• Never use "Other", "N/A", "Depends"

━━━ LANGUAGE RULE ━━━
Write the question and chips in the same language as the draft prompt.

━━━ OUTPUT FORMAT ━━━
Either return the next question:
{"done":false,"question":{"text":"...","multiSelect":false,"suggestions":["...","...","..."]}}

Or signal completion:
{"done":true}

No markdown, no explanation. Only valid JSON.`;
}

async function handleNextQuestion(msg, sendResponse) {
  const promptText   = sanitizeInput(msg.promptText,   8000);
  const modelProfile = sanitizeInput(msg.modelProfile, 600);
  const previousQA   = Array.isArray(msg.previousQA) ? msg.previousQA : [];
  const questionIndex = Number(msg.questionIndex) || 0;

  const { domain } = detectDomain(promptText);

  const historyBlock = previousQA.length === 0
    ? '(No questions asked yet — this is the first question.)'
    : previousQA.map((qa, i) =>
        `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer === '__skip__' ? '(choose the most suitable option)' : (qa.answer || '(skipped)')}`
      ).join('\n\n');

  const userPrompt = `${modelProfile ? `Target AI: ${modelProfile}\n\n` : ''}Draft prompt:
"""
${promptText}
"""

Questions asked so far (${questionIndex} of max 5):
${historyBlock}

Decide: is another question needed? If yes, generate the ONE most impactful next question, informed by the answers above. If not, return {"done":true}.`;

  try {
    const raw = await fetchWithFallback(
      [
        { role: 'system', content: buildNextQuestionSystemPrompt(domain) },
        { role: 'user',   content: userPrompt },
      ],
      { response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 400 },
    );

    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { throw new Error('BAD_RESPONSE'); }

    if (parsed.done === true) {
      sendResponse({ ok: true, done: true });
      return;
    }

    const q = parsed.question;
    if (!q || typeof q.text !== 'string' || !q.text.trim()) throw new Error('BAD_RESPONSE');
    if (!Array.isArray(q.suggestions) || q.suggestions.length < 1) throw new Error('BAD_RESPONSE');
    if ('multiSelect' in q) q.multiSelect = !!q.multiSelect;

    sendResponse({ ok: true, done: false, question: q });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleBuildImprovedPrompt(msg, sendResponse) {
  const originalText   = sanitizeInput(msg.originalText,  8000);
  const answersBlock   = sanitizeInput(msg.answersBlock,  3000);
  const modelProfile   = sanitizeInput(msg.modelProfile,  1200);
  const answeredCount  = Number(msg.answeredCount)  || 0;
  const totalQuestions = Number(msg.totalQuestions) || 0;

  const { domain, temperature } = detectDomain(originalText);
  const domainGuidance = DOMAIN_GUIDANCE[domain] || DOMAIN_GUIDANCE.general;

  const modelSection = modelProfile
    ? `TARGET MODEL FORMATTING RULES — apply these exactly to the rewritten prompt:\n${modelProfile}`
    : 'Write a clear, well-structured prompt compatible with any modern AI assistant.';

  const answerContext = answeredCount === 0
    ? 'The user skipped all clarifying questions. Improve the prompt based on the original text alone — add structure and clarity without inventing new requirements.'
    : answeredCount < totalQuestions
    ? `The user answered ${answeredCount} of ${totalQuestions} questions. Use only the provided answers. For unanswered fields, do NOT invent values — leave them open or use the most neutral framing.`
    : 'The user answered all clarifying questions. Incorporate every answer fully.';

  const systemPrompt = `You are a world-class prompt engineer. Transform the user's draft AI prompt into a precise, high-quality version.

━━━ DOMAIN ━━━
${domainGuidance}

━━━ MODEL ━━━
${modelSection}

━━━ ANSWER CONTEXT ━━━
${answerContext}

━━━ TRANSFORMATION RULES (follow strictly) ━━━
1. PRESERVE INTENT: The improved prompt must request the exact same type of output as the original. Code prompts stay code prompts. Essay prompts stay essay prompts. Never change the medium.
2. INCORPORATE ANSWERS: Every answered clarifying question must be visibly reflected in the improved prompt. Do not silently drop any answer.
3. NO INVENTION: Do not add constraints, features, requirements, or context the user did not provide. If a field is unanswered, leave it open.
4. NO META-TEXT: Output ONLY the final improved prompt. No preamble ("Here is your improved prompt:"), no explanation, no surrounding quotes, no markdown code blocks.
5. LANGUAGE MATCH: Write the improved prompt in the same language as the original draft.
6. NATURAL PROSE: The improved prompt should read like something a skilled human would naturally type — not a rigid template fill-in. Avoid bullet-point lists of requirements unless the original was already structured that way.

━━━ QUALITY CHECKLIST ━━━
Before outputting, verify:
□ Does the improved prompt ask for the same thing as the original?
□ Are all provided answers incorporated?
□ Is there any invented detail not from the original or answers? (Remove it if so)
□ Does it match the target model's formatting conventions?
□ Does it read naturally, not like a form?`;

  const userPrompt = `Original prompt:\n"""\n${originalText}\n"""\n\nClarifying answers:\n${answersBlock || '(none provided)'}\n\nWrite the improved prompt now.`;

  try {
    const improved = await fetchWithFallback(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      { temperature, max_tokens: 1500 },
    );

    // Strip any accidental meta-prefixes the model might add despite instructions
    const cleaned = improved.trim()
      .replace(/^(here is|here's|improved prompt:|rewritten prompt:|output:|result:)[:\s]*/i, '')
      .replace(/^["']|["']$/g, '')
      .trim();

    sendResponse({ ok: true, improvedPrompt: cleaned });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case 'CHECK_API_KEY':
      handleCheckApiKey(sendResponse);
      return true;
    case 'SAVE_API_KEY':
      handleSaveApiKey(msg, sendResponse);
      return true;
    case 'GET_OR_SET_MODEL_PROFILE':
      handleGetOrSetModelProfile(msg, sendResponse);
      return true;
    case 'GROQ_NEXT_QUESTION':
      handleNextQuestion(msg, sendResponse);
      return true;
    case 'GROQ_BUILD_IMPROVED_PROMPT':
      handleBuildImprovedPrompt(msg, sendResponse);
      return true;
  }

  return false;
});
