#!/usr/bin/env node

import crypto from 'node:crypto';

const MODEL_URL = 'https://models.github.ai/inference/chat/completions';
const FEED_X_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const MODEL = process.env.GITHUB_MODEL || 'openai/gpt-4o-mini';
const MAX_ITEMS = 8;

function cleanText(value, maxLength = 300) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function isLowInformation(tweet) {
  const text = cleanText(tweet.text, 2000);
  const withoutLinks = text.replace(/https?:\/\/\S+/g, '').trim();

  if (withoutLinks.length < 35) return true;
  if (/^(lol|lmao|wow|this is crazy|game changer|congrats|nice|yes|no)\b/i.test(withoutLinks)) {
    return true;
  }
  if (/\b(selfie|shitpost|subscribe|giveaway|sale|discount)\b/i.test(withoutLinks)) {
    return true;
  }
  return false;
}

async function loadCandidates() {
  const response = await fetch(FEED_X_URL);
  if (!response.ok) {
    throw new Error(`Could not fetch the central X feed (${response.status}).`);
  }
  const feed = await response.json();
  const candidates = [];

  for (const author of feed.x || []) {
    for (const tweet of author.tweets || []) {
      if (isLowInformation(tweet)) continue;
      candidates.push({
        name: cleanText(author.name, 80),
        identity_source: cleanText(author.bio, 180),
        text: cleanText(tweet.text, 1200),
        created_at: tweet.createdAt,
        url: tweet.url,
        likes: Number(tweet.likes || 0),
        retweets: Number(tweet.retweets || 0),
        replies: Number(tweet.replies || 0),
      });
    }
  }

  return candidates
    .sort((a, b) => (
      b.likes + b.retweets * 3 + b.replies -
      (a.likes + a.retweets * 3 + a.replies)
    ))
    .slice(0, 50);
}

function parseJsonResponse(raw) {
  const normalized = String(raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(normalized);
  } catch {
    const start = normalized.indexOf('{');
    const end = normalized.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(normalized.slice(start, end + 1));
    }
    throw new Error('GitHub Models did not return valid JSON.');
  }
}

function validateDigest(digest, candidates) {
  const knownUrls = new Set(candidates.map((item) => item.url));
  const items = (digest.items || [])
    .filter((item) => knownUrls.has(item.url))
    .slice(0, MAX_ITEMS)
    .map((item) => ({
      name: cleanText(item.name, 50),
      identity: cleanText(item.identity, 80) || 'AI 行业从业者',
      title: cleanText(item.title, 70),
      core: cleanText(item.core, 220),
      save_reason: cleanText(item.save_reason, 160),
      work_value: cleanText(item.work_value, 180),
      next_action: cleanText(item.next_action, 140),
      learning_status: cleanText(item.learning_status, 30) || '待阅读',
      url: item.url,
    }))
    .filter((item) => item.name && item.core);

  if (items.length === 0) {
    throw new Error('No high-value digest items were returned.');
  }

  return {
    overview: cleanText(digest.overview, 180) || '今日高信息量 AI 行业观点精选',
    items,
  };
}

async function summarizeWithGitHubModels(candidates) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is missing.');
  }

  const prompt = `你是严格的 AI 行业内容编辑。请从候选帖子中挑选最多 ${MAX_ITEMS} 条真正有信息量的内容，并输出简体中文 JSON。

筛选规则：
1. 删除日常闲聊、自拍、玩笑、纯转发、只有情绪没有事实的帖子。
2. 删除纯宣传、订阅引导和没有技术或行业信息的内容。
3. 只保留原创行业判断、技术见解、产品/模型更新、可复用方法、数据结果和趋势判断。
4. 同一博主的相似观点合并，只保留最有价值的一条。
5. 不得捏造事实；url 必须原样取自候选数据。

输出格式必须是一个 JSON 对象，不要 Markdown，不要代码围栏：
{
  "overview": "一句话概括今天最重要的共同主题",
  "items": [
    {
      "name": "博主名",
      "identity": "根据 bio 提炼的简短身份",
      "title": "中文标题",
      "core": "一句话核心观点",
      "save_reason": "为什么值得保存",
      "work_value": "对工作或学习 AI 的实际作用",
      "next_action": "一个具体、轻量的下一步行动",
      "learning_status": "待阅读",
      "url": "候选数据中的原帖网址"
    }
  ]
}

候选数据：
${JSON.stringify(candidates)}`;

  const response = await fetch(MODEL_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 3500,
      messages: [
        {
          role: 'system',
          content: '你只输出符合要求的 JSON；所有摘要使用简体中文。',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub Models request failed (${response.status}): ${await response.text()}`);
  }

  const result = await response.json();
  const raw = result.choices?.[0]?.message?.content;
  return validateDigest(parseJsonResponse(raw), candidates);
}

function beijingDate() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function buildCard(digest) {
  const elements = [
    {
      tag: 'markdown',
      content: `**今日主题：** ${digest.overview}\n\n已自动过滤闲聊、自拍、纯转发和无信息量内容。`,
    },
  ];

  digest.items.forEach((item, index) => {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: [
        `**${index + 1}. ${item.title}**`,
        `${item.name}（${item.identity}）`,
        `**核心内容：** ${item.core}`,
        `**为什么值得保存：** ${item.save_reason}`,
        `**工作 / AI 作用：** ${item.work_value}`,
        `**下一步行动：** ${item.next_action}`,
        `**学习状态：** ${item.learning_status}`,
        `[查看原帖](${item.url})`,
      ].join('\n'),
    });
  });

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: 'Joyce 的 AI 素材收件箱 · Follow Builders' }],
  });

  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: {
          tag: 'plain_text',
          content: `AI 博主精华日报 · ${beijingDate()}`,
        },
      },
      elements,
    },
  };
}

function addSignature(payload) {
  const secret = process.env.FEISHU_SIGNING_SECRET;
  if (!secret) return payload;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto
    .createHmac('sha256', stringToSign)
    .update('')
    .digest('base64');

  return { ...payload, timestamp, sign };
}

async function sendToFeishu(payload) {
  const webhook = process.env.FEISHU_WEBHOOK ||
    process.env.FEISHU_WEBHOOK_URL ||
    process.env.FEISHU_BOT_WEBHOOK;

  if (!webhook) {
    throw new Error(
      'Feishu webhook secret is missing. Add FEISHU_WEBHOOK, ' +
      'FEISHU_WEBHOOK_URL, or FEISHU_BOT_WEBHOOK in GitHub Actions secrets.',
    );
  }

  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(addSignature(payload)),
  });
  const raw = await response.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    result = { raw };
  }

  const code = result.code ?? result.StatusCode;
  if (!response.ok || (code !== undefined && Number(code) !== 0)) {
    throw new Error(`Feishu delivery failed (${response.status}): ${raw}`);
  }
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const sample = {
      overview: 'AI 正从单次问答转向可持续运行的工作系统。',
      items: [{
        name: '示例博主',
        identity: 'AI 产品负责人',
        title: '把提示词升级成可复用流程',
        core: '高质量 AI 工作需要固定规则、资料和验证步骤，而不是每次从零提问。',
        save_reason: '这是把个人经验沉淀成可复用工具的基础方法。',
        work_value: '可用于整理 Excel 对账规则和日常信息筛选。',
        next_action: '挑一项重复工作，先写清输入、判断规则和输出。',
        learning_status: '待阅读',
        url: 'https://github.com/joycekong920-spec/follow-builders',
      }],
    };
    console.log(JSON.stringify(buildCard(sample), null, 2));
    return;
  }

  const candidates = await loadCandidates();
  if (candidates.length === 0) {
    throw new Error('No high-value candidate posts found in feed-x.json.');
  }

  const digest = await summarizeWithGitHubModels(candidates);
  const card = buildCard(digest);
  await sendToFeishu(card);
  console.log(`Sent ${digest.items.length} high-value items to Feishu.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
