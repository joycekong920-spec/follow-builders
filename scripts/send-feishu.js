#!/usr/bin/env node

import crypto from "node:crypto";

const FEEDS = {
  x: "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json",
  podcasts: "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json",
  blogs: "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json"
};

const webhook = process.env.FEISHU_WEBHOOK;
const secret = process.env.FEISHU_SIGNING_SECRET;

if (!webhook || !secret) throw new Error("Missing Feishu secrets");

const clean = (value = "") =>
  value
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/t\.co\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const excerpt = (value, max = 360) => {
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
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: item.type === "X 动态" ? "blue" : item.type === "文章" ? "green" : "purple",
        title: { tag: "plain_text", content: `AI 日报精选 ${index}/${total} · ${item.type}` }
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**${item.title}**\n\n${excerpt(item.body) || "点击下方按钮查看原文。"}`
          }
        },
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

  const items = pickItems(feedX, feedPodcasts, feedBlogs);
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

  console.log(`Sent ${items.length} items to Feishu.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
