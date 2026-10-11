// Draft review suggestions.
//
// The Anthropic Messages API is called over plain fetch rather than
// @anthropic-ai/sdk because this project deliberately ships only three
// dependencies (express, qrcode, nodemailer). The request shape below is the
// documented one for POST /v1/messages.
//
// Only the rating, the chosen topics, the optional note and the business name
// and category are ever sent. The caller's email, name, IP and user id are not
// part of this module's input on purpose.

export const DRAFT_MIN = 20;
export const DRAFT_MAX = 400;
export const NOTE_MAX = 200;
export const MIN_DRAFTS = 5;
export const MAX_DRAFTS = 7;
export const TARGET_DRAFTS = 6;

// Businesses can define their own topic chips, so the phrase tables below are
// a quality shortcut for the common labels rather than the allowed set.

const EMOJI_OR_HASHTAG = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]|(^|\s)#\w/u;

export function sentimentFor(rating) {
  if (rating <= 2) return 'critical';
  if (rating === 3) return 'mixed';
  return 'positive';
}

const TOPIC_PHRASES = {
  positive: {
    Service: 'the service was attentive',
    Food: 'the food was enjoyable',
    Price: 'the price felt fair',
    Cleanliness: 'everything was clean',
    Staff: 'the staff were friendly',
    Atmosphere: 'the atmosphere was relaxed',
  },
  mixed: {
    Service: 'the service was a little uneven',
    Food: 'the food was fine without standing out',
    Price: 'the price seemed about average',
    Cleanliness: 'it was reasonably clean',
    Staff: 'the staff were pleasant but stretched',
    Atmosphere: 'the atmosphere was agreeable enough',
  },
  critical: {
    Service: 'the service did not work for me',
    Food: 'the food fell short of what I hoped for',
    Price: 'the price felt high for what I got',
    Cleanliness: 'cleanliness could be better',
    Staff: 'the staff seemed rushed',
    Atmosphere: 'the atmosphere was not for me',
  },
};

const NO_TOPIC_PHRASE = {
  positive: 'the visit went well from start to finish',
  mixed: 'the visit was a mixed experience',
  critical: 'the visit did not go the way I hoped',
};

// For topic labels a business invented, such as "Delivery time" or "Expertise".
// Rotated by position so several custom topics do not all read the same.
const GENERIC_PHRASES = {
  positive: ['{t} was a strong point', 'I was happy with {t}', '{t} was handled well'],
  mixed: ['{t} was mixed', '{t} was acceptable without standing out', '{t} was somewhere in between'],
  critical: ['{t} needs work', 'I was not satisfied with {t}', '{t} fell short for me'],
};

function phraseFor(topic, sentiment, index) {
  const known = TOPIC_PHRASES[sentiment][topic];
  if (known) return known;
  const options = GENERIC_PHRASES[sentiment];
  return options[index % options.length].replace('{t}', topic.toLowerCase());
}

function listJoin(parts) {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sentence(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function topicSentence(topics, sentiment) {
  const phrases = topics
    .filter((topic) => typeof topic === 'string' && topic.trim())
    .map((topic, index) => phraseFor(topic.trim(), sentiment, index));
  if (!phrases.length) return capitalize(sentence(NO_TOPIC_PHRASE[sentiment]));
  return capitalize(sentence(listJoin(phrases)));
}

// Template drafts. These are the offline fallback and the top-up source when
// the model returns too few usable drafts, so they must never mention anything
// the customer did not provide.
export function templateDrafts({ businessName, category = '', rating, topics = [], note = '' }) {
  const sentiment = sentimentFor(rating);
  const name = String(businessName || 'this place').trim();
  const kind = String(category || '').trim().toLowerCase() || 'place';
  const topicText = topicSentence(topics, sentiment);
  const noteText = note && String(note).trim() ? `${sentence(note)} ` : '';
  const stars = `${rating} out of 5`;

  const closers = {
    positive: {
      casual: 'I would go back.',
      warm: 'Thank you to the team there.',
      professional: `On balance I would recommend this ${kind}.`,
    },
    mixed: {
      casual: 'I would give it another try.',
      warm: 'I hope the quieter moments are more typical.',
      professional: `A reasonable ${kind}, with room to tighten things up.`,
    },
    critical: {
      casual: 'Not the visit I was hoping for.',
      warm: 'I hope this reads as useful feedback rather than a complaint.',
      professional: `I would want to see improvements before returning to this ${kind}.`,
    },
  }[sentiment];

  const openers = {
    positive: {
      casual: `Good visit to ${name}.`,
      warm: `I enjoyed my visit to ${name}.`,
      professional: `I visited ${name} and left satisfied.`,
    },
    mixed: {
      casual: `Mixed visit to ${name}.`,
      warm: `My visit to ${name} had its ups and downs.`,
      professional: `My visit to ${name} was a mixed one.`,
    },
    critical: {
      casual: `Disappointing visit to ${name}.`,
      warm: `I wanted to like ${name} more than I did.`,
      professional: `My visit to ${name} fell short of what I expected.`,
    },
  }[sentiment];

  // Ordered shortest to longest, cycling through casual, warm and professional.
  const withNote = [
    `${openers.casual} ${topicText}`,
    `${openers.warm} ${topicText} ${closers.warm}`,
    `${openers.casual} ${topicText} ${noteText}${closers.casual}`,
    `${openers.professional} ${topicText} ${noteText}${closers.professional}`,
    `${openers.warm} ${topicText} ${noteText}${closers.warm} I rated it ${stars}.`,
    `${openers.professional} ${topicText} ${noteText}${closers.professional} For context, I rated the visit ${stars}.`,
  ];
  // Note-free variants, used to top up when including a long note pushes a
  // draft past the character limit.
  const withoutNote = [
    `${openers.casual} ${topicText} ${closers.casual}`,
    `${openers.professional} ${topicText} ${closers.professional}`,
    `${openers.warm} ${topicText} I rated it ${stars}.`,
    `${openers.casual} ${topicText} I rated the visit ${stars}.`,
    `${openers.professional} ${topicText} ${closers.professional} I rated it ${stars}.`,
    `${openers.warm} ${topicText} ${closers.warm}`,
  ];

  return cleanDrafts([...withNote, ...withoutNote]);
}

// Trim, collapse whitespace, drop anything outside the allowed length, drop
// emojis and hashtags, and dedupe case-insensitively while keeping order.
export function cleanDrafts(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue;
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length < DRAFT_MIN || text.length > DRAFT_MAX) continue;
    if (EMOJI_OR_HASHTAG.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

export function buildSystemPrompt() {
  return [
    'You write first-person draft reviews that a customer can edit and post.',
    '',
    'Rules:',
    '- Use only the star rating, the chosen topics, the optional note, and the business name and category you are given.',
    '- Never invent dishes, staff names, prices, dates, events or any other fact. If you were not told it, do not write it.',
    '- Do not name a currency, an amount, a city, a country or a date. Do not guess them from the business name or category.',
    '- A topic chip means the customer wants that subject mentioned. It is not a claim about what happened, so keep what you say about it general.',
    '- Match the sentiment to the stars: 1-2 stars critical but civil, 3 stars mixed, 4-5 stars positive.',
    `- Write in the first person, vary the length and the tone (casual, warm, professional), and keep each draft between ${DRAFT_MIN} and ${DRAFT_MAX} characters.`,
    '- No emojis, no hashtags, no marketing language, and never mention AI or that the text was drafted for anyone.',
    '',
    `Return ONLY a JSON array of ${MIN_DRAFTS} to ${MAX_DRAFTS} strings. No preamble, no code fence, no keys, no explanation.`,
  ].join('\n');
}

export function buildUserPrompt({ businessName, category = '', rating, topics = [], note = '' }) {
  const lines = [
    `Business name: ${businessName}`,
    `Business category: ${category || 'not given'}`,
    `Star rating: ${rating} out of 5`,
    `Topics the customer chose: ${topics.length ? topics.join(', ') : 'none'}`,
    `Customer note: ${note && String(note).trim() ? String(note).trim() : 'none'}`,
  ];
  return `${lines.join('\n')}\n\nWrite the drafts now.`;
}

// Pulls the first JSON array out of the response text. The model is asked for a
// bare array, but a stray sentence or code fence should not break the feature.
export function extractJsonArray(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function createSuggester({ config, fetchImpl, logger = console } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;

  async function callModel(input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.anthropic.timeoutMs);
    try {
      const response = await doFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.anthropic.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: config.anthropic.model,
          max_tokens: 2000,
          // Six short drafts is a simple generation task and the whole call has
          // a 15 second budget, so keep the reasoning shallow.
          output_config: { effort: 'low' },
          system: buildSystemPrompt(),
          messages: [{ role: 'user', content: buildUserPrompt(input) }],
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Anthropic API responded ${response.status}: ${body.slice(0, 200)}`);
      }
      const payload = await response.json();
      // A safety decline comes back as HTTP 200 with no usable drafts.
      if (payload?.stop_reason === 'refusal') {
        throw new Error('The model declined the request.');
      }
      // Thinking blocks can precede the answer, so look for the text block
      // instead of reading content[0].
      const text = (payload?.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
      if (!text.trim()) throw new Error('The model returned no text.');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  // Always returns at least MIN_DRAFTS drafts: the model's usable ones first,
  // topped up with templates, so a missing key or a failed call stays invisible
  // to the customer.
  // useModel is the per-business switch: a business with AI drafts turned off
  // gets templates and the model is never called for it, whatever key the
  // server holds.
  async function suggest(input, { useModel = true } = {}) {
    const templates = templateDrafts(input);
    if (!useModel || !config.anthropic.apiKey) {
      return { drafts: templates.slice(0, TARGET_DRAFTS), source: 'template' };
    }

    let aiDrafts = [];
    try {
      aiDrafts = cleanDrafts(extractJsonArray(await callModel(input)));
    } catch (error) {
      logger.warn?.(`[suggest] using template drafts: ${error.message}`);
      return { drafts: templates.slice(0, TARGET_DRAFTS), source: 'template' };
    }

    const wanted = Math.min(Math.max(aiDrafts.length, TARGET_DRAFTS), MAX_DRAFTS);
    const drafts = cleanDrafts([...aiDrafts, ...templates]).slice(0, wanted);
    let source = 'ai';
    if (!aiDrafts.length) source = 'template';
    else if (aiDrafts.length < MIN_DRAFTS) source = 'mixed';
    return { drafts, source };
  }

  return { suggest, callModel };
}
