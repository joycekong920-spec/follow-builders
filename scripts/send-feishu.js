#!/usr/bin/env node

import crypto from "node:crypto";

const FEEDS = {
  x: "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json",
  podcasts: "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json",
  blogs: "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json"
};

const webhook = process.env.FEISHU_WEBHOOK;
const secret = process.env.FEISHU_SIGNING_SECRET;
const githubToken = process.env.GITHUB_TOKEN;

if (!webhook || !secret) throw new Error("Missing Feishu secrets");
if (!githubToken) throw new Error("Missing GITHUB_TOKEN");

const clean = (value = "") =>
  value
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/t\.co\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const excerpt = (value, max = 1500) => {
  const text = clean(value);
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
};

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch feed: ${response.status}`);
  return response.json();
}

function pickItems(feedX, feedPodcasts, feedBlogs) {
  const tweets = (feedX.x || [])
    .flatMap((builder) =>
      (builder.tweets || []).map((tweet) => ({
        type: "X 动态",
        source: `@${builder.handle || builder.name}`,
        title: `@${builder.handle || builder.name}`,
        body: tweet.text,
        url: tweet.url,
        score: (tweet.likes || 0) + (tweet.retweets || 0) * 2 + (tweet.replies || 0)
      }))
    )
    .filter((item) => clean(item.body).length >= 45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const blogs = (feedBlogs.blogs || [])
    .map((post) => ({
      type: "文章",
      source: post.name || "博客",
      title: post.title || post.name,
      body: post.description || post.content,
      url: post.url,
      score: Date.parse(post.publishedAt || "") || 0
    }))
    .filter((item) => item.url && clean(item.body).length >= 80)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  const podcasts = (feedPodcasts.podcasts || [])
    .map((episode) => ({
      type: "播客",
      source: episode.name || "播客",
      title: episode.title || episode.name,
      body: episode.transcript,
      url: episode.url,
      score: Date.parse(episode.publishedAt || "") || 0
    }))
    .filter((item) => item.url && clean(item.body).length >= 80)
    .sort((a, b) => b.score - a.score)
    .slice(0, 1);

  return [...tweets, ...blogs, ...podcasts];
}

async function summarizeInChinese(items) {
  const input = items.map((item, index) => ({
    id: index + 1,
    type: item.type,
    source: item.source,
    originalTitle: item.title,
    content: excerpt(item.body)
  }));

  const response = await fetch("https://models.github.ai/inference/chat/completions", {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({
      model: "openai/gpt-4o",
      temperature: 0.2,
      max_tokens: 2200,
      messages: [
        {
          role: "system",
          content:
            "你是一名中文AI资讯编辑。只依据提供的公开素材整理，不补充未经证实的信息。输出必须是纯JSON数组，不要Markdown代码围栏。每项必须包含id、title、summary、whyImportant、practicalUse。title不超过24个汉字；summary用2至3句通俗中文；whyImportant用1句；practicalUse用1句，面向非技术学习者以及进出口、供应链、物流工作者。如果内容与工作没有直接关系，就说明它对AI学习的用途。"
        },
        {
          role: "user",
          content: JSON.stringify(input)
        }
      ]
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub Models request failed: ${JSON.stringify(result)}`);
  }

  const raw = result.choices?.[0]?.message?.content || "";
  const jsonText = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const summaries = JSON.parse(jsonText);

  if (!Array.isArray(summaries) || summaries.length !== items.length) {
    throw new Error("GitHub Models returned an unexpected summary format");
  }

  return items.map((item, index) => ({
    ...item,
    chinese: summaries.find((entry) => Number(entry.id) === index + 1) || summaries[index]
  }));
}

function signedPayload(message) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac("sha256", stringToSign).update("").digest("base64");
  return { timestamp, sign, ...message };
}

async function send(message) {
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signedPayload(message))
  });
  const result = await response.json().catch(() => ({}));
  const code = result.code ?? result.StatusCode ?? 0;
  if (!response.ok || code !== 0) {
    throw new Error(`Feishu rejected the message: ${JSON.stringify(result)}`);
  }
}

function itemCard(item, index, total, date) {
  const info = item.chinese;
  const body =
    `**${info.title}**\n\n` +
    `**核心内容：** ${info.summary}\n\n` +
    `**为什么值得关注：** ${info.whyImportant}\n\n` +
    `**对你的用途：** ${info.practicalUse}\n\n` +
    `来源：${item.source}`;

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: item.type === "X 动态" ? "blue" : item.type === "文章" ? "green" : "purple",
        title: { tag: "plain_text", content: `AI 日报精选 ${index}/${total} · ${item.type}` }
      },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: body } },
        {
          tag: "note",
          elements: [
            { tag: "plain_text", content: `${date} · 觉得重要可在飞书中收藏这条消息` }
          ]
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              type: "primary",
              text: { tag: "plain_text", content: "查看原文" },
              url: item.url
            }
          ]
        }
      ]
    }
  };
}

async function main() {
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchJson(FEEDS.x),
    fetchJson(FEEDS.podcasts),
    fetchJson(FEEDS.blogs)
  ]);

  const selected = pickItems(feedX, feedPodcasts, feedBlogs);
  const items = await summarizeInChinese(selected);
  const date = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date());

  if (!items.length) {
    await send({
      msg_type: "text",
      content: { text: `${date}：今天的公共素材源暂时没有值得推送的新内容。` }
    });
    return;
  }

  for (let index = 0; index < items.length; index += 1) {
    await send(itemCard(items[index], index + 1, items.length, date));
    if (index < items.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  console.log(`Sent ${items.length} Chinese items to Feishu.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
