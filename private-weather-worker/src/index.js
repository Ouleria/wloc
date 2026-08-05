import {
  APP_CONFIG,
  WEATHER_LIMITS,
  WEEKDAY_TEXT,
  WEATHER_TEXT,
  SUMMER_HOLIDAY,
  CHINESE_NEW_YEAR_DAY_1,
} from './config.js';

const MAX_ICS_BYTES = 1_000_000;
const MIN_TOKEN_LENGTH = 32;
const MAX_OUTPUT_CHARS = 16_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: securityHeaders({ Allow: 'GET, HEAD, OPTIONS' }) });
    if (!['GET', 'HEAD'].includes(request.method)) return textResponse('只允许 GET 请求。', 405, { Allow: 'GET, HEAD, OPTIONS' });
    try {
      let response;
      if (url.pathname === '/health') response = textResponse('ok');
      else if (url.pathname === '/robots.txt') response = textResponse('User-agent: *\nDisallow: /\n');
      else if (url.pathname === '/favicon.ico') response = new Response(null, { status: 204, headers: securityHeaders() });
      else if (['/', '/daily', '/weather', '/index.html'].includes(url.pathname)) response = htmlResponse(renderPrivatePage(url.pathname === '/weather' ? 'weather' : 'daily'));
      else if (url.pathname === '/api/weather' || url.pathname === '/api/today') {
        requireAuthorization(request, env.ACCESS_TOKEN);
        response = textResponse(buildWeatherText(await buildWeatherResult(env, url.searchParams.get('date'))));
      } else if (url.pathname === '/api/daily') {
        requireAuthorization(request, env.ACCESS_TOKEN);
        response = textResponse(buildDailyText(await buildWeatherResult(env, url.searchParams.get('date'))));
      } else if (url.pathname === '/api/preview') {
        requireAuthorization(request, env.ACCESS_TOKEN);
        response = jsonResponse(buildPreviewSamples());
      } else response = textResponse('Not Found', 404);
      return request.method === 'HEAD' ? responseWithoutBody(response) : response;
    } catch (error) {
      const status = error && error.status ? error.status : 502;
      const response = textResponse(`获取失败：${safeErrorMessage(error)}`, status, { Vary: 'Authorization' });
      return request.method === 'HEAD' ? responseWithoutBody(response) : response;
    }
  },
};

function requireAuthorization(request, expectedToken) {
  const expected = String(expectedToken || '');
  if (expected.length < MIN_TOKEN_LENGTH) throw httpError(503, '尚未正确设置 ACCESS_TOKEN Secret（至少32位）');
  const authorization = request.headers.get('Authorization') || '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!constantTimeEqual(provided, expected)) throw httpError(401, '未授权：访问密码不正确');
}
function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

async function buildWeatherResult(env, dateOverride) {
  const timeZone = normalizeTimeZone(env.TIME_ZONE || APP_CONFIG.timeZone);
  const now = resolveNow(dateOverride);
  const sourceUrl = normalizeSourceUrl(env.METEOMATICS_ICS_URL);
  const upstream = await fetch(sourceUrl, {
    redirect: 'follow', cache: 'no-store',
    headers: { Accept: 'text/calendar,text/plain;q=0.9,*/*;q=0.8', 'User-Agent': 'CaiPrivateWeather/3.0' },
  });
  if (!upstream.ok) throw new Error(`天气订阅服务器返回 ${upstream.status}`);
  const length = Number(upstream.headers.get('Content-Length') || 0);
  if (length > MAX_ICS_BYTES) throw new Error('天气订阅内容过大，已停止读取');
  const raw = await upstream.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_ICS_BYTES) throw new Error('天气订阅内容过大，已停止读取');
  const dateKey = formatDateKey(now, timeZone);
  const weatherSource = extractTodayWeatherText(redactSourceSecrets(raw, sourceUrl), dateKey, timeZone);
  const slots = parseWeatherSlots(weatherSource);
  if (!slots.length) throw new Error('没有识别到8段天气，请把错误页面截图发来检查（不要截图Secret）');
  return { now, timeZone, dateKey, slots, analysis: analyzeWeather(slots), holiday: getHolidayState(now, timeZone) };
}

function normalizeSourceUrl(value) {
  if (!value) throw new Error('尚未设置 METEOMATICS_ICS_URL Secret');
  const normalized = String(value).trim().replace(/^webcal:/i, 'https:');
  let url;
  try { url = new URL(normalized); } catch { throw new Error('天气订阅地址格式不正确'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'ical.meteomatics.com' || !url.pathname.startsWith('/calendar/')) throw new Error('天气订阅地址必须来自 ical.meteomatics.com/calendar/');
  url.hash = '';
  return url;
}
function extractTodayWeatherText(raw, dateKey, timeZone) {
  if (!/BEGIN:VCALENDAR/i.test(raw)) return raw;
  const unfolded = raw.replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || [];
  const chunks = [];
  for (const block of blocks.slice(0, 300)) {
    const fields = parseIcsBlock(block);
    if (eventDateKey(fields.DTSTART || '', timeZone) === dateKey) chunks.push([fields.SUMMARY, fields.DESCRIPTION].filter(Boolean).join('\n'));
  }
  if (!chunks.length) {
    for (const block of blocks.slice(0, 300)) {
      const fields = parseIcsBlock(block);
      const text = [fields.SUMMARY, fields.DESCRIPTION].filter(Boolean).join('\n');
      if (text.includes(dateKey) || text.includes(dateKey.replaceAll('-', ''))) chunks.push(text);
    }
  }
  return chunks.join('\n');
}
function parseIcsBlock(block) {
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':'); if (i < 0) continue;
    const key = line.slice(0, i).split(';')[0].toUpperCase();
    if (['DTSTART', 'SUMMARY', 'DESCRIPTION'].includes(key)) out[key] = decodeIcsText(line.slice(i + 1));
  }
  return out;
}
function decodeIcsText(value) { return String(value).replace(/\\[nN]/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim(); }

function parseWeatherSlots(text) {
  const lines = String(text).replace(/\r/g, '').replace(/[‐‑‒–—−]/g, '-').replace(/\u00a0/g, ' ').split('\n').map((s) => s.trim()).filter(Boolean);
  const slots = [], seen = new Set();
  const patterns = [/(?:^|\s)(\d{1,2})\s*h?\s*-\s*(\d{1,2})\s*h?\s*[:：]\s*(.+)$/i, /(?:^|\s)(\d{1,2})\s*[:：]00\s*-\s*(\d{1,2})\s*[:：]00\s*[:：]?\s*(.+)$/i];
  for (const line of lines) {
    let match; for (const p of patterns) { match = line.match(p); if (match) break; }
    if (!match) continue;
    const start = Number(match[1]), end = Number(match[2]);
    if (start < 0 || start > 23 || end < 1 || end > 24) continue;
    const key = `${start}-${end}`; if (seen.has(key)) continue;
    const detail = match[3].trim();
    const tempMatch = detail.match(/(-?\d+(?:\.\d+)?)\s*°?\s*C/i);
    const temp = tempMatch ? Number(tempMatch[1]) : null;
    slots.push({ start, end, detail, temp, rain: isRainText(detail), thunder: /⛈|雷|thunder/i.test(detail), snow: /❄|雪|snow/i.test(detail) });
    seen.add(key);
  }
  return slots.sort((a, b) => a.start - b.start).slice(0, 8);
}
function isRainText(text) { return /🌦|🌧|⛈|☔|💧|雨|阵雨|陣雨|雷雨|rain|shower|drizzle|storm/i.test(text); }

function analyzeWeather(slots) {
  const temps = slots.map((s) => s.temp).filter(Number.isFinite);
  const min = temps.length ? Math.min(...temps) : null, max = temps.length ? Math.max(...temps) : null;
  const rainSlots = slots.filter((s) => s.rain), thunder = slots.some((s) => s.thunder), snow = slots.some((s) => s.snow);
  const rainPeriods = [...new Set(rainSlots.map((s) => periodName(s.start)))];
  const coldPeriods = [...new Set(slots.filter((s) => Number.isFinite(s.temp) && s.temp <= WEATHER_LIMITS.veryCold).map((s) => periodName(s.start)))];
  const concerns = [];
  if (thunder) concerns.push(WEATHER_TEXT.thunder);
  else if (snow) concerns.push(WEATHER_TEXT.snow);
  else if (rainSlots.length >= 6) concerns.push(WEATHER_TEXT.rainMostDay);
  else if (rainSlots.length >= 3) concerns.push(WEATHER_TEXT.rainSeveral({ periods: joinPeriods(rainPeriods) }));
  else if (rainPeriods.length === 1) concerns.push({凌晨:WEATHER_TEXT.rainNight,上午:WEATHER_TEXT.rainMorning,下午:WEATHER_TEXT.rainAfternoon,晚上:WEATHER_TEXT.rainEvening}[rainPeriods[0]]);
  else if (rainPeriods.length > 1) concerns.push(WEATHER_TEXT.rainMixed({ periods: joinPeriods(rainPeriods) }));
  if (Number.isFinite(max) && max >= WEATHER_LIMITS.veryHot) concerns.push(WEATHER_TEXT.veryHot({ max }));
  else if (Number.isFinite(max) && max >= WEATHER_LIMITS.hot) concerns.push(WEATHER_TEXT.hot({ max }));
  if (Number.isFinite(min) && min <= WEATHER_LIMITS.veryCold) concerns.push(WEATHER_TEXT.veryCold({ min, periods: coldPeriods.length ? joinPeriods(coldPeriods) : '部分时段' }));
  else if (Number.isFinite(min) && min <= WEATHER_LIMITS.cold) concerns.push(WEATHER_TEXT.cold({ min, periods: periodForMin(slots, min) }));
  else if (Number.isFinite(min) && min <= WEATHER_LIMITS.cool) concerns.push(WEATHER_TEXT.cool({ min, periods: periodForMin(slots, min) }));
  if (Number.isFinite(min) && Number.isFinite(max) && max - min >= WEATHER_LIMITS.largeDifference) concerns.push(WEATHER_TEXT.largeDifference({ min, max }));
  if (!concerns.length) concerns.push(APP_CONFIG.noWeatherText);
  return { min, max, rainCount: rainSlots.length, rainPeriods, thunder, snow, concerns };
}
function periodName(start) { if (start < 6) return '凌晨'; if (start < 12) return '上午'; if (start < 18) return '下午'; return '晚上'; }
function joinPeriods(periods) { return periods.join('、'); }
function periodForMin(slots, min) { return joinPeriods([...new Set(slots.filter((s) => s.temp === min).map((s) => periodName(s.start)))]) || '部分时段'; }

function getHolidayState(date, timeZone) {
  const p = localParts(date, timeZone), current = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const summerStart = new Date(Date.UTC(p.year, SUMMER_HOLIDAY.startMonth - 1, SUMMER_HOLIDAY.startDay));
  const summerEnd = new Date(Date.UTC(p.year, SUMMER_HOLIDAY.endMonth - 1, SUMMER_HOLIDAY.endDay));
  if (current >= summerStart && current <= summerEnd) return { isHoliday: true, type: '暑假' };
  const cny = CHINESE_NEW_YEAR_DAY_1[p.year];
  if (cny) {
    const [y,m,d] = cny.split('-').map(Number), cnyDate = new Date(Date.UTC(y,m-1,d));
    if (current >= addUtcDays(cnyDate,-7) && current <= addUtcDays(cnyDate,9)) return { isHoliday: true, type: '寒假' };
  }
  return { isHoliday: false, type: '' };
}
function buildWeatherText(result) { return [APP_CONFIG.weatherLead, ...result.slots.map(formatSlot), APP_CONFIG.weatherTail, '', APP_CONFIG.concernTitle, ...result.analysis.concerns].join('\n').slice(0, MAX_OUTPUT_CHARS); }
function buildDailyText(result) {
  const p = localParts(result.now, result.timeZone), weekday = WEEKDAY_TEXT[p.weekday];
  const useHolidayLine = result.holiday.isHoliday && (p.weekday === 3 || p.weekday === 4);
  return [APP_CONFIG.greeting, APP_CONFIG.timeLead, `〖${p.year}年${p.month}月${p.day}日 ${p.period}${p.hour12}:${String(p.minute).padStart(2,'0')}〗${APP_CONFIG.timeTail}`, buildWeatherText(result), weekday.title, weekday.line2, useHolidayLine ? weekday.holidayLine : weekday.schoolLine, weekday.line4, weekday.face].join('\n').slice(0, MAX_OUTPUT_CHARS);
}
function formatSlot(slot) { return `${String(slot.start).padStart(2,' ')}h - ${String(slot.end).padStart(2,' ')}h:${slot.detail}`; }

function renderPrivatePage(defaultView) {
  const title = defaultView === 'weather' ? '私人天气' : '私人每日早安', endpoint = defaultView === 'weather' ? '/api/weather' : '/api/daily';
  return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><meta name="robots" content="noindex,nofollow"><style>body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#0b0b0b;color:#eee;margin:0;padding:24px}main{max-width:900px;margin:auto}input,button{font-size:16px;padding:12px;border-radius:10px;border:1px solid #555}input{width:min(100%,560px);box-sizing:border-box;background:#171717;color:#fff}button{margin-top:12px;cursor:pointer}pre{white-space:pre-wrap;line-height:1.7;font-size:18px;background:#151515;padding:18px;border-radius:14px;min-height:120px}.nav a{color:#9ecbff;margin-right:16px}</style></head><body><main><h1>${title}</h1><p class="nav"><a href="/daily">完整早安</a><a href="/weather">天气检查</a></p><p>输入私人访问密码后读取；密码只保存在当前标签页，关闭后消失。</p><input id="token" type="password" autocomplete="off" placeholder="ACCESS_TOKEN"><br><button id="load">读取内容</button><pre id="output">等待读取……</pre><script>const t=document.getElementById('token'),o=document.getElementById('output');t.value=sessionStorage.getItem('weatherToken')||'';document.getElementById('load').onclick=async()=>{sessionStorage.setItem('weatherToken',t.value);o.textContent='读取中……';try{const r=await fetch('${endpoint}',{headers:{Authorization:'Bearer '+t.value},cache:'no-store'});o.textContent=await r.text()}catch(e){o.textContent='读取失败：'+e.message}};</script></main></body></html>`;
}
function buildPreviewSamples() { return { note:'这是格式预览，不是实时天气。', weather:`${APP_CONFIG.weatherLead}\n 0h -  3h:☁️ 🌡27°C\n 3h -  6h:🌦 🌡27°C 💧\n 6h -  9h:🌥 🌡28°C\n 9h - 12h:🌦 🌡29°C 💧\n12h - 15h:🌦 🌡33°C 💧\n15h - 18h:🌥 🌡34°C\n18h - 21h:☁️ 🌡29°C\n21h - 24h:☁️ 🌡27°C\n${APP_CONFIG.weatherTail}\n\n${APP_CONFIG.concernTitle}\n今天上午、下午可能会下雨噢，菜菜出门记得带伞啦喂。\n今天会比较热欸，菜菜记得多喝水。`, holidayWednesday:[WEEKDAY_TEXT[3].title,WEEKDAY_TEXT[3].line2,WEEKDAY_TEXT[3].holidayLine,WEEKDAY_TEXT[3].line4,WEEKDAY_TEXT[3].face].join('\n'), schoolWednesday:[WEEKDAY_TEXT[3].title,WEEKDAY_TEXT[3].line2,WEEKDAY_TEXT[3].schoolLine,WEEKDAY_TEXT[3].line4,WEEKDAY_TEXT[3].face].join('\n') }; }
function resolveNow(dateOverride) { if (!dateOverride) return new Date(); if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) throw httpError(400,'date测试参数必须是 YYYY-MM-DD'); const d=new Date(`${dateOverride}T04:00:00Z`); if(Number.isNaN(d.getTime())) throw httpError(400,'date测试参数无效'); return d; }
function localParts(date,timeZone){const parts=new Intl.DateTimeFormat('zh-TW',{timeZone,year:'numeric',month:'numeric',day:'numeric',weekday:'short',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(date);const m=Object.fromEntries(parts.map(x=>[x.type,x.value]));const wm={'週日':0,'周日':0,'星期日':0,'週一':1,'周一':1,'星期一':1,'週二':2,'周二':2,'星期二':2,'週三':3,'周三':3,'星期三':3,'週四':4,'周四':4,'星期四':4,'週五':5,'周五':5,'星期五':5,'週六':6,'周六':6,'星期六':6};return{year:Number(m.year),month:Number(m.month),day:Number(m.day),weekday:wm[m.weekday]??date.getUTCDay(),hour12:Number(m.hour)||12,minute:Number(m.minute),period:/下午|晚上/.test(m.dayPeriod||'')?'下午':'上午'};}
function formatDateKey(date,timeZone){const p=localParts(date,timeZone);return`${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
function eventDateKey(rawValue,timeZone){const raw=String(rawValue||'').trim();if(/^\d{8}$/.test(raw))return`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;const m=raw.match(/^(\d{8})T(\d{6})(Z|[+-]\d{4})?$/);if(!m)return'';if(!m[3])return`${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}`;const z=m[3]==='Z'?'Z':`${m[3].slice(0,3)}:${m[3].slice(3)}`;const iso=`${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}T${m[2].slice(0,2)}:${m[2].slice(2,4)}:${m[2].slice(4,6)}${z}`;const d=new Date(iso);return Number.isNaN(d.getTime())?'':formatDateKey(d,timeZone);}
function normalizeTimeZone(value){try{new Intl.DateTimeFormat('en',{timeZone:value}).format();return value}catch{throw new Error('TIME_ZONE设置不正确')}}
function addUtcDays(date,days){const d=new Date(date);d.setUTCDate(d.getUTCDate()+days);return d;}
function redactSourceSecrets(text,sourceUrl){let out=String(text);const segments=sourceUrl.pathname.split('/').filter(Boolean).slice(1,3);for(const s of segments){let decoded=s;try{decoded=decodeURIComponent(s)}catch{}for(const f of[s,decoded,decoded.replace('_',','),decoded.replace('_',', ')])if(f&&f.length>=4)out=out.split(f).join('[位置已隐藏]')}return out.replace(/(?:https?|webcal):\/\/\S+/gi,'[链接已隐藏]').replace(/[-+]?\d{1,3}(?:\.\d{3,})?\s*[,;_]\s*[-+]?\d{1,3}(?:\.\d{3,})?/g,'[坐标已隐藏]');}
function securityHeaders(extra={}){return{'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Permissions-Policy':'geolocation=(), camera=(), microphone=()','Cache-Control':'no-store, no-cache, must-revalidate, max-age=0','X-Robots-Tag':'noindex, nofollow, noarchive',...extra};}
function textResponse(body,status=200,extra={}){return new Response(body,{status,headers:securityHeaders({'Content-Type':'text/plain; charset=utf-8',...extra})});}
function htmlResponse(body){return new Response(body,{headers:securityHeaders({'Content-Type':'text/html; charset=utf-8'})});}
function jsonResponse(obj){return new Response(JSON.stringify(obj,null,2),{headers:securityHeaders({'Content-Type':'application/json; charset=utf-8'})});}
function responseWithoutBody(response){return new Response(null,{status:response.status,headers:response.headers});}
function httpError(status,message){const e=new Error(message);e.status=status;return e;}
function safeErrorMessage(error){return String(error instanceof Error?error.message:'未知错误').replace(/(?:https?|webcal):\/\/\S+/gi,'[已隐藏地址]').replace(/[\r\n]+/g,' ').slice(0,220);}
