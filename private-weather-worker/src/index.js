const DEFAULT_TIME_ZONE = "Asia/Taipei";
const PAGE_TITLE = "私人天气";
const WEATHER_TITLE = "〖 菜菜今天天气啦喂 〗";
const MAX_ICS_BYTES = 1_000_000;
const MAX_EVENTS = 200;
const MAX_OUTPUT_CHARS = 12_000;
const MIN_TOKEN_LENGTH = 32;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: securityHeaders({
          Allow: "GET, HEAD, OPTIONS",
        }),
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("只允许 GET 请求。", 405, {
        Allow: "GET, HEAD, OPTIONS",
      });
    }

    try {
      let response;

      if (url.pathname === "/" || url.pathname === "/index.html") {
        response = htmlResponse(renderPrivatePage());
      } else if (url.pathname === "/health") {
        response = textResponse("ok", 200);
      } else if (url.pathname === "/robots.txt") {
        response = textResponse("User-agent: *\nDisallow: /\n", 200);
      } else if (url.pathname === "/favicon.ico") {
        response = new Response(null, {
          status: 204,
          headers: securityHeaders(),
        });
      } else if (url.pathname === "/api/today") {
        if (!isAuthorized(request, env.ACCESS_TOKEN)) {
          response = textResponse("未授权：请输入正确的私人访问密码。", 401, {
            "WWW-Authenticate": 'Bearer realm="Private Weather"',
            Vary: "Authorization",
          });
        } else {
          const weatherText = await getTodayWeather(env);
          response = textResponse(weatherText, 200, {
            Vary: "Authorization",
          });
        }
      } else {
        response = textResponse("Not Found", 404);
      }

      return request.method === "HEAD" ? responseWithoutBody(response) : response;
    } catch (error) {
      // 不记录或回显订阅 URL、地址、经纬度、访问密码和上游响应正文。
      const response = textResponse(`天气获取失败：${safeErrorMessage(error)}`, 502, {
        Vary: "Authorization",
      });
      return request.method === "HEAD" ? responseWithoutBody(response) : response;
    }
  },
};

function isAuthorized(request, expectedToken) {
  const expected = String(expectedToken || "");
  if (expected.length < MIN_TOKEN_LENGTH) return false;

  const authorization = request.headers.get("Authorization") || "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  return constantTimeEqual(provided, expected);
}

function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }

  return diff === 0;
}

async function getTodayWeather(env) {
  const sourceUrl = normalizeAndValidateSourceUrl(env.METEOMATICS_ICS_URL);
  const timeZone = normalizeTimeZone(env.TIME_ZONE || DEFAULT_TIME_ZONE);

  const upstream = await fetch(sourceUrl, {
    method: "GET",
    redirect: "follow",
    cache: "no-store",
    headers: {
      Accept: "text/calendar, text/plain;q=0.9, */*;q=0.8",
      "User-Agent": "PrivateWeatherWorker/2.0",
    },
  });

  if (!upstream.ok) {
    throw new Error(`天气订阅服务器返回 ${upstream.status}`);
  }

  const declaredLength = Number(upstream.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_ICS_BYTES) {
    throw new Error("天气订阅内容过大，已停止读取");
  }

  const icsText = await upstream.text();
  if (new TextEncoder().encode(icsText).byteLength > MAX_ICS_BYTES) {
    throw new Error("天气订阅内容过大，已停止读取");
  }

  if (!/BEGIN:VCALENDAR/i.test(icsText)) {
    throw new Error("订阅内容不是有效的 iCalendar 数据");
  }

  const events = parseIcsEvents(icsText);
  if (events.length === 0) {
    throw new Error("订阅中没有找到天气事件");
  }

  const todayKey = formatDateKey(new Date(), timeZone);
  const todayEvents = events
    .filter((event) => eventDateKey(event.dtstart, timeZone) === todayKey)
    .sort((a, b) =>
      sortableDateValue(a.dtstart).localeCompare(sortableDateValue(b.dtstart)),
    );

  if (todayEvents.length === 0) {
    throw new Error(`没有找到 ${todayKey} 的天气预报，稍后再试`);
  }

  const sensitiveFragments = sourceSensitiveFragments(sourceUrl);
  const weatherBody = buildWeatherBody(todayEvents, sensitiveFragments);
  if (!weatherBody) {
    throw new Error("找到今天的事件，但没有可安全显示的天气文字");
  }

  return `${WEATHER_TITLE}\n${todayKey}\n\n${weatherBody}`.slice(
    0,
    MAX_OUTPUT_CHARS,
  );
}

function normalizeAndValidateSourceUrl(value) {
  if (!value) throw new Error("尚未设置 METEOMATICS_ICS_URL Secret");

  const normalized = String(value).trim().replace(/^webcal:/i, "https:");
  let url;

  try {
    url = new URL(normalized);
  } catch {
    throw new Error("天气订阅地址格式不正确");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "ical.meteomatics.com" ||
    !url.pathname.startsWith("/calendar/")
  ) {
    throw new Error("天气订阅地址必须来自 ical.meteomatics.com/calendar/");
  }

  if (url.username || url.password) {
    throw new Error("天气订阅地址不能包含账号或密码");
  }

  url.hash = "";
  return url;
}

function normalizeTimeZone(value) {
  const timeZone = String(value || DEFAULT_TIME_ZONE).trim();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    throw new Error("TIME_ZONE 时区设置不正确");
  }
}

function sourceSensitiveFragments(sourceUrl) {
  const segments = sourceUrl.pathname.split("/").filter(Boolean);
  const fragments = new Set();

  for (const segment of segments.slice(1, 3)) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // 保留原字符串，后续仍会做坐标和地址格式过滤。
    }

    if (decoded.length >= 4) fragments.add(decoded);
    if (segment.length >= 4) fragments.add(segment);

    if (/^-?\d+(?:\.\d+)?_-?\d+(?:\.\d+)?$/.test(decoded)) {
      fragments.add(decoded.replace("_", ","));
      fragments.add(decoded.replace("_", ", "));
      fragments.add(decoded.replace("_", " "));
    }
  }

  return [...fragments].sort((a, b) => b.length - a.length);
}

function parseIcsEvents(icsText) {
  const unfolded = String(icsText).replace(/\r?\n[ \t]/g, "");
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || [];

  return blocks.slice(0, MAX_EVENTS).flatMap((block) => {
    const event = {
      dtstart: "",
      dtend: "",
      summary: "",
      description: "",
    };

    for (const line of block.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;

      const rawKey = line.slice(0, colon);
      const value = line.slice(colon + 1);
      const key = rawKey.split(";", 1)[0].toUpperCase();

      if (key === "DTSTART") event.dtstart = value.trim();
      if (key === "DTEND") event.dtend = value.trim();
      if (key === "SUMMARY") event.summary = decodeIcsText(value);
      if (key === "DESCRIPTION") event.description = decodeIcsText(value);
    }

    return event.dtstart ? [event] : [];
  });
}

function decodeIcsText(value) {
  return String(value)
    .replace(/\\[nN]/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function eventDateKey(rawValue, timeZone) {
  const raw = String(rawValue || "").trim();

  if (/^\d{8}$/.test(raw)) {
    return compactDateToKey(raw);
  }

  const match = raw.match(/^(\d{8})T(\d{4}(?:\d{2})?)(Z|[+-]\d{4})?$/);
  if (!match) return "";

  const [, datePart, timePart, suffix] = match;
  if (!suffix) return compactDateToKey(datePart);

  const hh = timePart.slice(0, 2);
  const mm = timePart.slice(2, 4);
  const ss = timePart.slice(4, 6) || "00";
  const zone =
    suffix === "Z"
      ? "Z"
      : `${suffix.slice(0, 3)}:${suffix.slice(3, 5)}`;
  const iso = `${compactDateToKey(datePart)}T${hh}:${mm}:${ss}${zone}`;
  const parsed = new Date(iso);

  return Number.isNaN(parsed.getTime()) ? "" : formatDateKey(parsed, timeZone);
}

function compactDateToKey(raw) {
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function sortableDateValue(rawValue) {
  return String(rawValue || "");
}

function formatDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function buildWeatherBody(events, sensitiveFragments) {
  const chunks = [];

  for (const event of events) {
    const description = sanitizeWeatherText(
      event.description,
      sensitiveFragments,
    );
    const summary = sanitizeWeatherText(event.summary, sensitiveFragments);

    if (description) {
      chunks.push(description);
    } else if (summary) {
      chunks.push(summary);
    }
  }

  return dedupeLines(chunks.join("\n"));
}

function sanitizeWeatherText(text, sensitiveFragments) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => redactSensitiveFragments(line, sensitiveFragments))
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^(?:location|geo|address|地址|位置|地點|地点)\s*[:：]/i.test(line),
    )
    .filter(
      (line) =>
        !/(?:meteomatics|forecast\s+by|weather\s+calendar)/i.test(line),
    )
    .filter((line) => !/(?:https?|webcal):\/\//i.test(line))
    .filter((line) => !containsCoordinate(line))
    .filter((line) => !looksLikeStreetAddress(line))
    .map((line) => line.replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);

  return lines.join("\n");
}

function redactSensitiveFragments(line, sensitiveFragments) {
  let result = String(line);

  for (const fragment of sensitiveFragments) {
    if (!fragment) continue;
    result = result.split(fragment).join("[位置已隐藏]");
  }

  return result;
}

function containsCoordinate(line) {
  return /(?:^|[^\d])[-+]?(?:[1-8]?\d(?:\.\d{3,})?|90(?:\.0+)?)\s*[,;_]\s*[-+]?(?:(?:1[0-7]\d|[1-9]?\d)(?:\.\d{3,})?|180(?:\.0+)?)(?:[^\d]|$)/.test(
    line,
  );
}

function looksLikeStreetAddress(line) {
  return /(?:\d{3,6}\s*)?.*(?:路|街|巷|弄|號|号)\s*\d*/.test(line);
}

function dedupeLines(text) {
  const seen = new Set();
  const result = [];

  for (const line of String(text).split("\n")) {
    const key = line.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }

  return result.join("\n");
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : "未知错误";

  return String(message)
    .replace(/(?:https?|webcal):\/\/\S+/gi, "[已隐藏地址]")
    .replace(
      /[-+]?\d{1,3}(?:\.\d{3,})?\s*[,;_]\s*[-+]?\d{1,3}(?:\.\d{3,})?/g,
      "[已隐藏坐标]",
    )
    .replace(/[\r\n]+/g, " ")
    .slice(0, 180);
}

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
    ...extra,
  };
}

function textResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: securityHeaders({
      "Content-Type": "text/plain; charset=utf-8",
      ...extraHeaders,
    }),
  });
}

function htmlResponse(body) {
  return new Response(body, {
    status: 200,
    headers: securityHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    }),
  });
}

function responseWithoutBody(response) {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function renderPrivatePage() {
  return `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
  <meta name="referrer" content="no-referrer">
  <title>${PAGE_TITLE}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      padding: 24px 16px;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #0b0b0b;
      color: #e8e8e8;
    }
    main { width: min(760px, 100%); margin: 0 auto; }
    h1 { margin: 0 0 16px; font-size: 25px; }
    .panel {
      padding: 18px;
      border: 1px solid #333;
      border-radius: 14px;
      background: #151515;
    }
    label { display: block; margin-bottom: 8px; }
    input, button {
      width: 100%;
      min-height: 46px;
      border-radius: 10px;
      font: inherit;
    }
    input {
      border: 1px solid #555;
      padding: 10px 12px;
      background: #080808;
      color: #fff;
    }
    button {
      margin-top: 12px;
      border: 0;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled { cursor: wait; opacity: .65; }
    .secondary {
      background: transparent;
      color: #bbb;
      border: 1px solid #444;
    }
    #weather {
      display: none;
      margin-top: 16px;
      padding: 18px;
      border: 1px solid #333;
      border-radius: 14px;
      background: #111;
      white-space: pre-wrap;
      line-height: 1.75;
      font-size: 20px;
      word-break: break-word;
    }
    #status { margin-top: 12px; color: #bbb; min-height: 1.5em; }
    .note { margin-top: 12px; color: #999; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <h1>私人天气</h1>
    <section class="panel" id="loginPanel">
      <label for="token">私人访问密码</label>
      <input id="token" type="password" autocomplete="current-password" placeholder="输入部署时设置的 ACCESS_TOKEN">
      <button id="loadButton" type="button">查看今天的天气</button>
      <button id="forgetButton" class="secondary" type="button">清除本标签页保存的密码</button>
      <div id="status" role="status" aria-live="polite"></div>
      <div class="note">密码只保存在当前浏览器标签页；关闭标签页后会清除。密码和天气订阅链接都不会写进网址。</div>
    </section>
    <pre id="weather" aria-live="polite"></pre>
  </main>
  <script>
    const tokenInput = document.getElementById('token');
    const loadButton = document.getElementById('loadButton');
    const forgetButton = document.getElementById('forgetButton');
    const statusEl = document.getElementById('status');
    const weatherEl = document.getElementById('weather');

    try {
      const saved = sessionStorage.getItem('private_weather_token');
      if (saved) tokenInput.value = saved;
    } catch {}

    async function loadWeather() {
      const token = tokenInput.value.trim();
      if (!token) {
        statusEl.textContent = '请先输入私人访问密码。';
        return;
      }

      loadButton.disabled = true;
      statusEl.textContent = '正在读取天气……';
      weatherEl.style.display = 'none';

      try {
        const response = await fetch('/api/today', {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + token },
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer'
        });
        const text = await response.text();
        if (!response.ok) throw new Error(text);
        try { sessionStorage.setItem('private_weather_token', token); } catch {}
        weatherEl.textContent = text;
        weatherEl.style.display = 'block';
        statusEl.textContent = '';
      } catch (error) {
        statusEl.textContent = error.message || '读取失败';
      } finally {
        loadButton.disabled = false;
      }
    }

    loadButton.addEventListener('click', loadWeather);
    forgetButton.addEventListener('click', () => {
      try { sessionStorage.removeItem('private_weather_token'); } catch {}
      tokenInput.value = '';
      weatherEl.textContent = '';
      weatherEl.style.display = 'none';
      statusEl.textContent = '已清除。';
      tokenInput.focus();
    });
    tokenInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') loadWeather();
    });
  </script>
</body>
</html>`;
}
