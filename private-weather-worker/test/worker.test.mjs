import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const ACCESS_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PRIVATE_ADDRESS = "000測試市測試區測試路1巷2弄3號";
const SOURCE_URL =
  `webcal://ical.meteomatics.com/calendar/${encodeURIComponent(PRIVATE_ADDRESS)}` +
  "/35.123456_139.654321/en/meteomatics";

function todayCompact(timeZone = "Asia/Taipei") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

function makeIcs(description, date = todayCompact()) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `DTSTART;VALUE=DATE:${date}`,
    `DTEND;VALUE=DATE:${date}`,
    "SUMMARY:Sunny 29 °C",
    `DESCRIPTION:${description}`,
    `LOCATION:${PRIVATE_ADDRESS}`,
    "GEO:35.123456;139.654321",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function env(overrides = {}) {
  return {
    ACCESS_TOKEN,
    METEOMATICS_ICS_URL: SOURCE_URL,
    TIME_ZONE: "Asia/Taipei",
    ...overrides,
  };
}

test("root page contains no private source data and sends privacy headers", async () => {
  const response = await worker.fetch(
    new Request("https://weather.example/"),
    env(),
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(response.headers.get("x-robots-tag"), /noindex/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.doesNotMatch(body, /ical\.meteomatics\.com/i);
  assert.doesNotMatch(body, /35\.123456/);
  assert.doesNotMatch(body, new RegExp(PRIVATE_ADDRESS));
});

test("API rejects a missing token without contacting the weather source", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("should not be called");
  };

  try {
    const response = await worker.fetch(
      new Request("https://weather.example/api/today"),
      env(),
    );

    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authorized API converts webcal to HTTPS and redacts location data", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedCacheMode = "";

  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedCacheMode = init.cache;
    return new Response(
      makeIcs(
        [
          "Temperature: 29 °C",
          "Condition: Sunny",
          `Address: ${PRIVATE_ADDRESS}`,
          "Coordinates: 35.123456,139.654321",
          "https://example.com/private",
        ].join("\\n"),
      ),
      {
        status: 200,
        headers: { "Content-Type": "text/calendar" },
      },
    );
  };

  try {
    const request = new Request("https://weather.example/api/today", {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const response = await worker.fetch(request, env());
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(requestedUrl, /^https:\/\/ical\.meteomatics\.com\/calendar\//);
    assert.equal(requestedCacheMode, "no-store");
    assert.match(body, /菜菜今天天气啦喂/);
    assert.match(body, /Temperature: 29 °C/);
    assert.match(body, /Condition: Sunny/);
    assert.doesNotMatch(body, new RegExp(PRIVATE_ADDRESS));
    assert.doesNotMatch(body, /35\.123456/);
    assert.doesNotMatch(body, /example\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid source host is rejected before any upstream request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("should not be called");
  };

  try {
    const request = new Request("https://weather.example/api/today", {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const response = await worker.fetch(
      request,
      env({ METEOMATICS_ICS_URL: "https://evil.example/calendar/private" }),
    );
    const body = await response.text();

    assert.equal(response.status, 502);
    assert.equal(calls, 0);
    assert.doesNotMatch(body, /evil\.example/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HEAD has no body and unsupported methods return 405", async () => {
  const head = await worker.fetch(
    new Request("https://weather.example/", { method: "HEAD" }),
    env(),
  );
  const post = await worker.fetch(
    new Request("https://weather.example/", { method: "POST" }),
    env(),
  );

  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(post.status, 405);
  assert.match(post.headers.get("allow"), /GET/);
});
